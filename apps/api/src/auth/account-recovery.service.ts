import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import * as crypto from 'crypto';
import { AuthTokenKind, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { passwordChangedNotice, passwordResetEmail, verificationCodeEmail } from '../mail/mail.templates';
import {
  decryptVerificationCode,
  EMAIL_CODE_PATTERN,
  encryptVerificationCode,
  generateVerificationCode,
  hashVerificationCode,
  verifyCodeHash
} from './verification-code.util';
import { AuthService, isStaffRoleValue, StaffManagementActor, staffManagementError } from './auth.service';

export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
/** Verification emails per user per hour (registration email + resends). */
export const MAX_VERIFICATION_EMAILS_PER_HOUR = 5;
/** Email verification codes are valid for 15 minutes. */
export const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
/** Wrong attempts allowed per code; the code is burned on the fifth wrong attempt. */
export const MAX_CODE_ATTEMPTS = 5;
/** Minimum interval between two verification codes for the same account. */
export const RESEND_COOLDOWN_MS = 60 * 1000;
/** Password reset emails per account per hour (excess requests still answer 200, silently). */
export const MAX_RESET_EMAILS_PER_HOUR = 3;

export const INVALID_TOKEN_MESSAGE = 'This link is invalid or has expired. Please request a new one.';

export function invalidTokenException(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: 'INVALID_OR_EXPIRED_TOKEN',
    error: 'Bad Request',
    message: INVALID_TOKEN_MESSAGE
  });
}

export function emailNotVerifiedException(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    code: 'EMAIL_NOT_VERIFIED',
    message:
      'Please confirm your email address before continuing. Use the link sent to your inbox, or request a new link from your dashboard.'
  });
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Absolute public site base for emailed links (PUBLIC_SITE_URL, e.g. https://www.gcdis.in, without a
 * trailing slash). Links point at the web app's /portal/verify-email and /portal/reset-password pages.
 * Outside production an unset value falls back to the local web app (http://localhost:3000).
 * Production refuses anything but an https:// URL, so a reset token is never emailed over a plain-http link.
 */
export function publicSiteBase(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NODE_ENV === 'production' && emailLinkConfigErrors(env).length > 0) {
    throw new Error('PUBLIC_SITE_URL must be an absolute https:// URL in production');
  }
  const raw = (env.PUBLIC_SITE_URL || '').trim() || 'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

/** Startup check: in production emailed links need an absolute https:// PUBLIC_SITE_URL. */
export function emailLinkConfigErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const raw = (env.PUBLIC_SITE_URL || '').trim();
  if (!raw) return ['PUBLIC_SITE_URL is required in production (verification and password reset links).'];
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') throw new Error('protocol');
    if (url.username || url.password || url.search || url.hash) throw new Error('query');
  } catch {
    return ['PUBLIC_SITE_URL must be an absolute https:// URL such as https://www.gcdis.in (verification and password reset links).'];
  }
  return [];
}

/** 503 when a verification email could not be handed to the mail server. */
export function emailDeliveryFailedException(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    code: 'EMAIL_DELIVERY_FAILED',
    error: 'Service Unavailable',
    message: 'The verification email could not be sent at this time. Please try again later or contact the GCDIS Secretariat.'
  });
}

/** Result of POST /auth/verify-email. */
export interface VerifyEmailResult {
  success: true;
  /** The address had already been verified (e.g. the link was opened a second time). */
  alreadyVerified?: true;
}

/** Result of POST /auth/resend-verification. */
export interface ResendVerificationResult {
  success: true;
  alreadyVerified?: true;
  /** When the new code expires / when another code may be requested (ISO 8601). */
  expiresAt?: string;
  resendAvailableAt?: string;
}

/** Pending code metadata (never the code itself). */
export interface PendingCodeInfo {
  sentAt: string;
  expiresAt: string;
  attemptsRemaining: number;
}

/** GET /auth/verification-status (captain session). */
export interface VerificationStatus {
  verified: boolean;
  pending: PendingCodeInfo | null;
  resendAvailableAt: string | null;
}

/** 400 { code, message } for a rejected verification code. */
export function codeException(code: string, message: string, extra: Record<string, unknown> = {}): BadRequestException {
  return new BadRequestException({ statusCode: 400, code, error: 'Bad Request', message, ...extra });
}

/** GET /auth/email-delivery: lets the portal explain (development only) that emails are not delivered. */
export interface EmailDeliveryInfo {
  /** Always true in production (the API does not start without SMTP). */
  deliveryConfigured: boolean;
}

/**
 * Email verification and password reset for team captains (security round 3).
 * Tokens: 32 random bytes (base64url), only the SHA-256 hash is stored, single use; issuing a new
 * token invalidates older unused tokens of the same kind.
 */
@Injectable()
export class AccountRecoveryService {
  private readonly logger = new Logger(AccountRecoveryService.name);

  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
    @Optional() private mail?: MailService
  ) {}

  /** Creates a token (invalidating older unused tokens of the same kind) and returns the raw value. */
  async issueToken(userId: string, kind: AuthTokenKind, ttlMs: number): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.authToken.updateMany({
        where: { userId, kind, usedAt: null },
        data: { usedAt: now }
      }),
      this.prisma.authToken.create({
        data: { userId, kind, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + ttlMs) }
      })
    ]);
    return token;
  }

  /** Looks up a live token without consuming it. */
  private async findLiveToken(token: unknown, kind: AuthTokenKind) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return null;
    }
    const record = await this.prisma.authToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true }
    });
    if (!record || record.kind !== kind || record.usedAt || record.expiresAt.getTime() <= Date.now()) return null;
    if (!record.user || !record.user.isActive) return null;
    return record;
  }

  /** Marks the token used; false if another request consumed it first. */
  private async consume(id: string): Promise<boolean> {
    const res = await this.prisma.authToken.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } });
    return res.count === 1;
  }

  private async recentTokenCount(userId: string, kind: AuthTokenKind): Promise<number> {
    return this.prisma.authToken.count({
      where: { userId, kind, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } }
    });
  }

  /**
   * Issues a new 6-digit verification code (invalidating every earlier code or link of the account) and
   * returns it. Only a salted HMAC and an AES-256-GCM ciphertext are stored.
   */
  async issueVerificationCode(userId: string): Promise<{ code: string; expiresAt: Date }> {
    const code = generateVerificationCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EMAIL_CODE_TTL_MS);
    await this.prisma.$transaction([
      this.prisma.authToken.updateMany({
        where: { userId, kind: AuthTokenKind.EMAIL_VERIFY, usedAt: null },
        data: { usedAt: now, codeCipher: null }
      }),
      this.prisma.authToken.create({
        data: {
          userId,
          kind: AuthTokenKind.EMAIL_VERIFY,
          tokenHash: hashVerificationCode(userId, code),
          codeCipher: encryptVerificationCode(userId, code),
          attempts: 0,
          expiresAt
        }
      })
    ]);
    return { code, expiresAt };
  }

  /** The newest unused, unexpired verification code row of the account (or null). */
  private async findPendingCode(userId: string) {
    const row = await this.prisma.authToken.findFirst({
      where: { userId, kind: AuthTokenKind.EMAIL_VERIFY, usedAt: null, codeCipher: { not: null } },
      orderBy: { createdAt: 'desc' }
    });
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    return row;
  }

  private pendingInfo(row: { createdAt: Date; expiresAt: Date; attempts: number }): PendingCodeInfo {
    return {
      sentAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      attemptsRemaining: Math.max(0, MAX_CODE_ATTEMPTS - (row.attempts ?? 0))
    };
  }

  /** When the account may receive another code (cooldown after the latest one), or null when it may now. */
  private async resendAvailableAt(userId: string): Promise<Date | null> {
    const latest = await this.prisma.authToken.findFirst({
      where: { userId, kind: AuthTokenKind.EMAIL_VERIFY },
      orderBy: { createdAt: 'desc' }
    });
    if (!latest) return null;
    const at = latest.createdAt.getTime() + RESEND_COOLDOWN_MS;
    return at > Date.now() ? new Date(at) : null;
  }

  /**
   * Issues a verification code and emails it (registration, resend). Never throws (registration must
   * not fail on email). The code appears in logs only in the development outbox line.
   */
  async sendVerificationEmail(user: { id: string; email: string; fullName?: string | null }): Promise<boolean> {
    try {
      const { code } = await this.issueVerificationCode(user.id);
      if (!this.mail) return false;
      return await this.mail.sendSafe({
        to: user.email,
        ...verificationCodeEmail(user.fullName, code, EMAIL_CODE_TTL_MS / 60000),
        logLabel: 'GCDIS verification code',
        devLink: `code: ${code}`
      });
    } catch (err: any) {
      this.logger.error(`Verification email could not be prepared: ${err?.message || 'unknown error'}`);
      return false;
    }
  }

  /**
   * POST /auth/verify-email-code (captain session). Constant-time comparison; five wrong attempts burn
   * the code. Success marks the address verified and consumes the code (single use).
   */
  async verifyEmailCode(userId: string, rawCode: unknown, ipAddress?: string, userAgent?: string): Promise<VerifyEmailResult> {
    const code = typeof rawCode === 'string' ? rawCode.replace(/\s+/g, '') : '';
    if (!EMAIL_CODE_PATTERN.test(code)) {
      throw codeException('INVALID_CODE_FORMAT', 'Please enter the six-digit code from the verification email.');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw new UnauthorizedException('User not found or account deactivated');
    if (user.emailVerifiedAt) return { success: true, alreadyVerified: true };

    const row = await this.findPendingCode(user.id);
    if (!row) {
      throw codeException('CODE_EXPIRED', 'There is no valid verification code for this account. Please request a new code.');
    }

    if (!verifyCodeHash(user.id, code, row.tokenHash)) {
      // Atomic increment of the attempt counter on the still-live row
      await this.prisma.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { attempts: { increment: 1 } } });
      const fresh = await this.prisma.authToken.findUnique({ where: { id: row.id } });
      const attempts = fresh?.attempts ?? (row.attempts ?? 0) + 1;
      if (attempts >= MAX_CODE_ATTEMPTS) {
        await this.prisma.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date(), codeCipher: null } });
        await this.authService.recordAccountEvent('AUTH_EMAIL_CODE_LOCKED', user, ipAddress, userAgent, {
          email: user.email,
          attempts
        });
        throw codeException(
          'CODE_LOCKED',
          'The code was entered incorrectly too many times and is no longer valid. Please request a new code.'
        );
      }
      const remaining = MAX_CODE_ATTEMPTS - attempts;
      throw codeException(
        'INVALID_CODE',
        `The code is not correct. ${remaining} ${remaining === 1 ? 'attempt remains' : 'attempts remain'}.`,
        { attemptsRemaining: remaining }
      );
    }

    // Single use: the first request to consume the row wins
    const consumed = await this.prisma.authToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date(), codeCipher: null }
    });
    if (consumed.count !== 1) {
      throw codeException('CODE_EXPIRED', 'There is no valid verification code for this account. Please request a new code.');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    await this.authService.recordAccountEvent('AUTH_EMAIL_VERIFIED', user, ipAddress, userAgent, {
      email: user.email,
      method: 'CODE',
      alreadyVerified: false
    });
    return { success: true };
  }

  /** GET /auth/verification-status (captain session): never includes the code. */
  async verificationStatus(userId: string): Promise<VerificationStatus> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw new UnauthorizedException('User not found or account deactivated');
    if (user.emailVerifiedAt) return { verified: true, pending: null, resendAvailableAt: null };
    const [row, resendAt] = await Promise.all([this.findPendingCode(user.id), this.resendAvailableAt(user.id)]);
    return {
      verified: false,
      pending: row ? this.pendingInfo(row) : null,
      resendAvailableAt: resendAt ? resendAt.toISOString() : null
    };
  }

  /**
   * POST /auth/verify-email. A link that was already used (or superseded / expired) for an address that
   * is now verified answers { success: true, alreadyVerified: true } instead of an error, so opening
   * the link twice does not tell a verified captain that something went wrong.
   */
  async verifyEmail(token: unknown, ipAddress?: string, userAgent?: string): Promise<VerifyEmailResult> {
    const record = await this.findLiveToken(token, AuthTokenKind.EMAIL_VERIFY);
    if (!record || !(await this.consume(record.id))) {
      if (await this.isSpentTokenOfVerifiedUser(token)) return { success: true, alreadyVerified: true };
      throw invalidTokenException();
    }

    const user = record.user;
    const alreadyVerified = Boolean(user.emailVerifiedAt);
    if (!alreadyVerified) {
      await this.prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    }
    await this.authService.recordAccountEvent('AUTH_EMAIL_VERIFIED', user, ipAddress, userAgent, {
      email: user.email,
      alreadyVerified
    });
    return alreadyVerified ? { success: true, alreadyVerified: true } : { success: true };
  }

  /** True when the token is a genuine (used or expired) verification token of an active, verified account. */
  private async isSpentTokenOfVerifiedUser(token: unknown): Promise<boolean> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return false;
    }
    const record = await this.prisma.authToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true }
    });
    return Boolean(
      record && record.kind === AuthTokenKind.EMAIL_VERIFY && record.user && record.user.isActive && record.user.emailVerifiedAt
    );
  }

  /** GET /auth/email-delivery */
  emailDeliveryInfo(): EmailDeliveryInfo {
    if (process.env.NODE_ENV === 'production') return { deliveryConfigured: true };
    return { deliveryConfigured: Boolean(this.mail?.isSmtpConfigured()) };
  }

  /** POST /auth/resend-verification (captain session) */
  async resendVerification(userId: string, ipAddress?: string, userAgent?: string): Promise<ResendVerificationResult> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw new UnauthorizedException('User not found or account deactivated');
    if (user.emailVerifiedAt) return { success: true, alreadyVerified: true };

    await this.assertVerificationEmailAllowance(user.id);

    const sent = await this.sendVerificationEmail(user);
    await this.authService.recordAccountEvent('AUTH_VERIFICATION_EMAIL_SENT', user, ipAddress, userAgent, {
      email: user.email,
      emailSent: sent
    });
    if (!sent) throw emailDeliveryFailedException();
    const now = Date.now();
    return {
      success: true,
      expiresAt: new Date(now + EMAIL_CODE_TTL_MS).toISOString(),
      resendAvailableAt: new Date(now + RESEND_COOLDOWN_MS).toISOString()
    };
  }

  /**
   * 429 during the cooldown after the latest code (RESEND_COOLDOWN_MS) and once
   * MAX_VERIFICATION_EMAILS_PER_HOUR codes were issued for the account within an hour.
   */
  private async assertVerificationEmailAllowance(userId: string): Promise<void> {
    const cooldownUntil = await this.resendAvailableAt(userId);
    if (cooldownUntil) {
      const wait = Math.max(1, Math.ceil((cooldownUntil.getTime() - Date.now()) / 1000));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'RESEND_COOLDOWN',
          error: 'Too Many Requests',
          message: `A verification code was sent a moment ago. Please wait ${wait} seconds before requesting another.`,
          retryAfterSeconds: wait,
          resendAvailableAt: cooldownUntil.toISOString()
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    if ((await this.recentTokenCount(userId, AuthTokenKind.EMAIL_VERIFY)) >= MAX_VERIFICATION_EMAILS_PER_HOUR) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'VERIFICATION_EMAIL_LIMIT',
          error: 'Too Many Requests',
          message: 'A verification code has been sent several times in the past hour. Please check your inbox or try again later.'
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }

  /** Loads the target of a staff verification action: an existing, active team captain account. */
  private async loadCaptainTarget(actor: StaffManagementActor, targetId: string) {
    if (actor.id === targetId) {
      throw staffManagementError('SELF_MODIFICATION_NOT_ALLOWED', 'You cannot change the email verification of your own account.');
    }
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundException('The requested account could not be found.');
    if (isStaffRoleValue(target.role) || target.role !== Role.TEAM_CAPTAIN) {
      throw staffManagementError(
        'ROLE_BOUNDARY',
        'Email verification can be managed only for team captain accounts. Staff accounts are verified when they are provisioned.'
      );
    }
    if (!target.isActive) {
      throw staffManagementError('ACCOUNT_DEACTIVATED', 'The account is deactivated. Reactivate it before managing its email verification.');
    }
    return target;
  }

  /**
   * POST /auth/users/:id/resend-verification (administrators): sends a new verification code to an
   * unverified team captain. Shares the per-account hourly cap with the captain's own resends.
   */
  async adminResendVerification(actor: StaffManagementActor, targetId: string, ipAddress?: string, userAgent?: string) {
    const target = await this.loadCaptainTarget(actor, targetId);
    if (target.emailVerifiedAt) {
      throw staffManagementError('ALREADY_VERIFIED', 'The email address of this account has already been verified.');
    }
    await this.assertVerificationEmailAllowance(target.id);
    const sent = await this.sendVerificationEmail(target);
    await this.authService.recordUserManagementEvent(
      'USER_VERIFICATION_EMAIL_RESENT',
      actor,
      target,
      ipAddress,
      userAgent,
      { emailVerified: false },
      { emailSent: sent }
    );
    if (!sent) throw emailDeliveryFailedException();
    const now = Date.now();
    return {
      success: true as const,
      email: target.email,
      expiresAt: new Date(now + EMAIL_CODE_TTL_MS).toISOString(),
      resendAvailableAt: new Date(now + RESEND_COOLDOWN_MS).toISOString()
    };
  }

  /**
   * GET /auth/captains/awaiting-verification: unverified captains with their teams and the metadata of
   * the pending code (sent, expiry, attempts left). The code itself is only returned by the reveal action.
   */
  async listPendingVerifications(page: { take: number; skip: number }, search?: string) {
    const { items, total } = await this.authService.findCaptainsAwaitingVerification(page, search);
    const ids = items.map((u: any) => u.id);
    const rows = ids.length
      ? await this.prisma.authToken.findMany({
          where: {
            userId: { in: ids },
            kind: AuthTokenKind.EMAIL_VERIFY,
            usedAt: null,
            codeCipher: { not: null },
            expiresAt: { gt: new Date() }
          },
          orderBy: { createdAt: 'desc' },
          select: { userId: true, createdAt: true, expiresAt: true, attempts: true }
        })
      : [];
    const byUser = new Map<string, PendingCodeInfo>();
    for (const r of rows) if (!byUser.has(r.userId)) byUser.set(r.userId, this.pendingInfo(r));
    return { items: items.map((u: any) => ({ ...u, pendingCode: byUser.get(u.id) ?? null })), total };
  }

  /**
   * POST /auth/users/:id/reveal-verification-code (administrators, step-up): decrypts the captain's
   * pending code so staff can pass it on by telephone while email delivery is unavailable. Audited
   * (without the code).
   */
  async adminRevealVerificationCode(actor: StaffManagementActor, targetId: string, ipAddress?: string, userAgent?: string) {
    const target = await this.loadCaptainTarget(actor, targetId);
    if (target.emailVerifiedAt) {
      throw staffManagementError('ALREADY_VERIFIED', 'The email address of this account has already been verified.');
    }
    const row = await this.findPendingCode(target.id);
    const code = row ? decryptVerificationCode(target.id, row.codeCipher) : null;
    if (!row || !code) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'NO_PENDING_CODE',
        message: 'There is no valid verification code for this account. Send a new code first.'
      });
    }
    await this.authService.recordUserManagementEvent(
      'USER_VERIFICATION_CODE_REVEALED',
      actor,
      target,
      ipAddress,
      userAgent,
      {},
      { codeIssuedAt: row.createdAt.toISOString(), codeExpiresAt: row.expiresAt.toISOString() }
    );
    return { code, ...this.pendingInfo(row) };
  }

  /**
   * POST /auth/users/:id/mark-email-verified (administrators, step-up): marks a team captain's
   * address as verified without the emailed link (e.g. confirmed by telephone). Outstanding
   * verification links are invalidated. Never applies to staff accounts or to the caller.
   */
  async adminMarkEmailVerified(
    actor: StaffManagementActor,
    targetId: string,
    reason: string | undefined,
    ipAddress?: string,
    userAgent?: string
  ) {
    const target = await this.loadCaptainTarget(actor, targetId);
    if (target.emailVerifiedAt) {
      throw staffManagementError('ALREADY_VERIFIED', 'The email address of this account has already been verified.');
    }
    const cleanReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : null;
    const now = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: target.id }, data: { emailVerifiedAt: now } }),
      this.prisma.authToken.updateMany({
        where: { userId: target.id, kind: AuthTokenKind.EMAIL_VERIFY, usedAt: null },
        data: { usedAt: now, codeCipher: null }
      })
    ]);
    await this.authService.recordUserManagementEvent(
      'USER_EMAIL_MARKED_VERIFIED',
      actor,
      target,
      ipAddress,
      userAgent,
      { emailVerifiedAt: null },
      { emailVerifiedAt: now.toISOString(), method: 'MANUAL', reason: cleanReason }
    );
    const { passwordHash, twoFactor, googleSub, ...rest } = updated as any;
    return { ...rest, emailVerified: true };
  }

  /**
   * POST /auth/forgot-password: always answers { success: true } (no account enumeration). The work
   * runs after the response is prepared so the response time does not depend on the account existing.
   */
  forgotPassword(email: unknown, ipAddress?: string, userAgent?: string): { success: true } {
    void this.processForgotPassword(email, ipAddress, userAgent).catch((err) =>
      this.logger.error(`Password reset request failed: ${err?.message || 'unknown error'}`)
    );
    return { success: true };
  }

  /** Sends a reset email to an active team captain. Resolves true when an email was sent. */
  async processForgotPassword(email: unknown, ipAddress?: string, userAgent?: string): Promise<boolean> {
    if (typeof email !== 'string') return false;
    const normalised = email.trim().toLowerCase();
    if (!normalised || normalised.length > 254) return false;

    const user = await this.prisma.user.findUnique({ where: { email: normalised } });
    // Only team captain accounts can reset by email; staff are reset by a Super Administrator.
    if (!user || !user.isActive || user.role !== Role.TEAM_CAPTAIN) return false;

    if ((await this.recentTokenCount(user.id, AuthTokenKind.PASSWORD_RESET)) >= MAX_RESET_EMAILS_PER_HOUR) {
      this.logger.warn(`Password reset email limit reached for user ${user.id}; request ignored.`);
      return false;
    }

    const token = await this.issueToken(user.id, AuthTokenKind.PASSWORD_RESET, PASSWORD_RESET_TTL_MS);
    const link = `${publicSiteBase()}/portal/reset-password?token=${encodeURIComponent(token)}`;
    const sent = this.mail
      ? await this.mail.sendSafe({ to: user.email, ...passwordResetEmail(user.fullName, link), devLink: `link: ${link}` })
      : false;
    await this.authService.recordAccountEvent('AUTH_PASSWORD_RESET_REQUESTED', user, ipAddress, userAgent, {
      email: user.email,
      emailSent: sent
    });
    return sent;
  }

  /** POST /auth/reset-password */
  async resetPassword(token: unknown, newPassword: unknown, ipAddress?: string, userAgent?: string): Promise<{ success: true }> {
    const record = await this.findLiveToken(token, AuthTokenKind.PASSWORD_RESET);
    if (!record) throw invalidTokenException();
    const user = record.user;

    // Policy (incl. the 128-character cap) is checked before the token is consumed, so a rejected
    // password does not burn the link
    await this.authService.validatePasswordPolicy(typeof newPassword === 'string' ? newPassword : '', user.email, user.role);

    if (!(await this.consume(record.id))) throw invalidTokenException();

    const passwordHash = await this.authService.hashPassword(newPassword as string);
    const now = new Date();
    const [, revoked] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          isPasswordTemporary: false,
          mustChangePassword: false,
          // Opening the emailed link proves control of the address
          ...(user.emailVerifiedAt ? {} : { emailVerifiedAt: now })
        }
      }),
      // Every session of the user is revoked
      this.prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now, isActive: false }
      }),
      // Any other outstanding reset link stops working
      this.prisma.authToken.updateMany({
        where: { userId: user.id, kind: AuthTokenKind.PASSWORD_RESET, usedAt: null },
        data: { usedAt: now }
      })
    ]);

    await this.authService.recordAccountEvent('AUTH_PASSWORD_RESET_COMPLETED', user, ipAddress, userAgent, {
      email: user.email,
      sessionsRevoked: (revoked as any)?.count ?? 0
    });
    if (this.mail) {
      void this.mail.sendSafe({ to: user.email, ...passwordChangedNotice(user.fullName) });
    }
    return { success: true };
  }
}
