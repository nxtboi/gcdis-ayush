import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  Optional
} from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, Role } from '@prisma/client';
import { LoginInput, RegisterUserInput, UserRole } from '@gcdis/shared';
import { TwoFactorService } from './two-factor.service';
import { AuditService } from '../audit/audit.service';
import { getAdminJwtSecret, getChallengeJwtSecret, getPublicJwtSecret } from './jwt-secrets';
import { isAdminIpAllowed } from '../common/utils/ip-allowlist.util';
import { adminSessionMaxMs, stepUpRequiredException, STEP_UP_WINDOW_MS } from './step-up.guard';
import { SecurityAlertService } from '../security/security-alert.service';
import {
  evaluatePasswordPolicy,
  PASSWORD_MAX_LENGTH,
  PASSWORD_POLICY_MESSAGES,
  passwordMinLengthForRole,
  passwordTooShortMessage
} from './password-policy';
import { MailService } from '../mail/mail.service';
import { staffNewSignInNotice } from '../mail/mail.templates';
import { appendAuditLog } from '../audit/audit-chain';
import {
  adminIdleTimeoutMinutes,
  adminMaxSessions,
  ipNetworkOf,
  isSessionIdle,
  REVOKED_IDLE_TIMEOUT,
  REVOKED_SESSION_LIMIT,
  sessionIdleTimeoutException,
  sessionLastActivity,
  STAFF_DEVICE_HISTORY_DAYS,
  userAgentFamily
} from './staff-session-policy';

const ADMIN_ROLES = [Role.SUPER_ADMIN, Role.EVENT_ADMIN, Role.JUDGE, Role.INSPECTOR];
/** Public (portal) refresh sessions: 7-day sliding lifetime (unchanged). */
const PUBLIC_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

type AuthAuditAction =
  | 'AUTH_LOGIN_SUCCESS'
  | 'AUTH_2FA_ENABLED'
  | 'AUTH_PASSWORD_CHANGED'
  | 'AUTH_LOGOUT_ALL'
  | 'AUTH_RECOVERY_CODE_USED'
  | 'AUTH_STEP_UP_SUCCESS'
  | 'AUTH_STEP_UP_FAILED'
  | 'AUTH_SESSION_REVOKED'
  | 'AUTH_ADMIN_IP_DENIED'
  | 'AUTH_EMAIL_VERIFIED'
  | 'AUTH_VERIFICATION_EMAIL_SENT'
  | 'AUTH_EMAIL_CODE_LOCKED'
  | 'AUTH_PASSWORD_RESET_REQUESTED'
  | 'AUTH_PASSWORD_RESET_COMPLETED'
  | 'AUTH_SESSION_IDLE_TIMEOUT'
  | 'AUTH_SESSION_LIMIT_REVOKED'
  | 'AUTH_NEW_DEVICE_SIGN_IN';

/** GET /auth/users scope filter. */
export type UsersScope = 'all' | 'staff' | 'captains';

/** Optional GET /auth/users filters. */
export interface UsersFilters {
  /** Email verification status. */
  verified?: boolean;
  /** Only active accounts. */
  activeOnly?: boolean;
}

/** Teams led by a captain, with their registration count (captain listings). */
const CAPTAIN_TEAMS_INCLUDE = {
  teamsLed: {
    select: { id: true, name: true, code: true, createdAt: true, _count: { select: { registrations: true } } },
    orderBy: { createdAt: 'asc' as const }
  }
};

/** Audit actions written for staff actions on another account (the target is the audited entity). */
export type UserManagementAuditAction =
  | 'STAFF_ROLE_CHANGED'
  | 'STAFF_USER_CREATED'
  | 'USER_DEACTIVATED'
  | 'USER_REACTIVATED'
  | 'USER_VERIFICATION_EMAIL_RESENT'
  | 'USER_EMAIL_MARKED_VERIFIED'
  | 'USER_VERIFICATION_CODE_REVEALED';

/** The Super Administrator performing a user-management action (req.user). */
export interface StaffManagementActor {
  id: string;
  email?: string | null;
  role?: string | null;
}

/** True for SUPER_ADMIN, EVENT_ADMIN, JUDGE and INSPECTOR. */
export function isStaffRoleValue(role: unknown): role is Role {
  return typeof role === 'string' && (ADMIN_ROLES as readonly string[]).includes(role);
}

/** 400 { statusCode, code, message } for a rejected user-management request. */
export function staffManagementError(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, code, error: 'Bad Request', message });
}

/** Failed sign-ins (per email + IP, 15 minutes) that lock the account for that IP. */
const LOGIN_LOCKOUT_THRESHOLD = 5;
/** Failed sign-ins for one account (any IP) within ACCOUNT_SOFT_LOCK_WINDOW_MS that lock it temporarily. */
export const ACCOUNT_SOFT_LOCK_THRESHOLD = 20;
export const ACCOUNT_SOFT_LOCK_WINDOW_MS = 60 * 60 * 1000;

/** 403 answered while an account is soft-locked after repeated failures from any network. */
export function accountSoftLockException(): ForbiddenException {
  return new ForbiddenException(
    'Too many failed sign-in attempts for this account. For your security it is temporarily locked; please try again later or reset your password.'
  );
}
/** 401 answered for a staff session signed out because the account exceeded ADMIN_MAX_SESSIONS. */
export function sessionLimitRevokedException(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    code: 'SESSION_LIMIT_REVOKED',
    error: 'Unauthorized',
    message: 'This session was signed out because your account signed in on another device and the limit of concurrent sessions was reached.'
  });
}

/** 400 { code: 'WEAK_PASSWORD', message } (password policy, security round 3). */
export function weakPasswordException(message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, code: 'WEAK_PASSWORD', error: 'Bad Request', message });
}

/** Carried from a rotated session to its successor. */
interface SessionCarryOver {
  expiresAt?: Date;
  stepUpAt?: Date | null;
  rotated?: boolean;
  /** Staff: last activity of the rotated session, so a refresh never resets the idle clock. */
  lastSeenAt?: Date | null;
}
const CHALLENGE_AUDIENCE = 'gcdis-2fa-challenge';
/** Every token we issue is HS256; verification never accepts another algorithm. */
const JWT_ALGORITHMS: ['HS256'] = ['HS256'];
type ChallengeType = '2fa_challenge' | '2fa_enrolment_challenge';

/**
 * Fingerprint of the state that a successful 2FA sign-in changes (last accepted TOTP step and
 * the set of used recovery codes). Embedded in login challenge tokens to make them single-use.
 */
export function twoFactorStateFingerprint(record: { lastUsedStep?: number | bigint | null; backupCodes?: unknown } | null): string {
  const used = Array.isArray(record?.backupCodes)
    ? (record!.backupCodes as any[]).filter((c) => c && c.used !== false).length
    : 0;
  const step = record?.lastUsedStep === null || record?.lastUsedStep === undefined ? '-' : String(record.lastUsedStep);
  return crypto.createHash('sha256').update(`${step}:${used}`).digest('base64url').slice(0, 16);
}
const DUMMY_HASH ='$2a$12$e80MvQkQ1u9P4XvG7W/7ye6J6bNqGfLw7O8r7J3K0N0G4e0q8aV6u';
const BREACHED_PASSWORDS = [
  'password123456',
  'password1234!',
  'admin123456!',
  'gcdis2026!secret',
  'welcome123456!',
  'superadmin123!'
];

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private twoFactorService: TwoFactorService,
    @Optional() private auditService?: AuditService,
    @Optional() private securityAlerts?: SecurityAlertService,
    @Optional() private mail?: MailService
  ) {}

  /** Raises a security alert without ever affecting the request (fire-and-forget). */
  private raiseAlert(...args: Parameters<SecurityAlertService['alert']>): void {
    try {
      if (this.securityAlerts) void this.securityAlerts.alert(...args).catch(() => undefined);
    } catch {
      // Non-fatal
    }
  }

  /** Public wrapper so collaborating auth services share one audit format. */
  async recordAccountEvent(
    action: AuthAuditAction,
    user: { id: string; email?: string | null; role?: string | null },
    ipAddress?: string,
    userAgent?: string,
    afterState?: Record<string, unknown>
  ) {
    await this.auditAuthEvent(action, user, ipAddress, userAgent, afterState);
  }

  /**
   * Security audit trail for account events (QA L4). Never fails the auth flow: an audit write
   * error is swallowed exactly like login-attempt recording.
   */
  private async auditAuthEvent(
    action: AuthAuditAction,
    user: { id: string; email?: string | null; role?: string | null },
    ipAddress?: string,
    userAgent?: string,
    afterState?: Record<string, unknown>
  ) {
    const entry = {
      actorId: user.id,
      actorEmail: user.email ?? undefined,
      actorRole: user.role ?? undefined,
      action,
      entityType: 'User',
      entityId: user.id,
      afterState,
      ipAddress,
      userAgent
    };
    if (action === 'AUTH_ADMIN_IP_DENIED') {
      this.raiseAlert('ADMIN_IP_DENIED', user.email || user.id, { ipAddress, ...(afterState || {}) });
    }
    try {
      if (this.auditService) {
        await this.auditService.logAction(entry);
      } else if ((this.prisma as any).auditLog?.create) {
        await appendAuditLog(this.prisma, { ...entry, ipAddress: ipAddress || '127.0.0.1', userAgent: userAgent || 'Unknown' });
      }
    } catch {
      // Non-fatal
    }
  }

  /**
   * Password policy (see password-policy.ts): 12-128 characters (14 for staff roles), three of four character
   * classes, not containing the email local part, not in the offline breach list and not in the Have I Been
   * Pwned corpus (k-anonymity, fail open). Throws 400 { code: 'WEAK_PASSWORD', message }.
   * Applies to new and changed passwords only; existing passwords are never re-checked at sign-in.
   */
  async validatePasswordPolicy(password: string, email?: string | null, role?: string | null): Promise<void> {
    const minLength = passwordMinLengthForRole(role);
    // 12 characters for every account; staff roles need STAFF_PASSWORD_MIN_LENGTH (14)
    if (typeof password !== 'string' || !password || password.length < 12 || password.length < minLength) {
      throw weakPasswordException(minLength === 12 ? PASSWORD_POLICY_MESSAGES.TOO_SHORT : passwordTooShortMessage(minLength));
    }
    // Offline dictionary: still applies when the HIBP lookup is disabled or unreachable
    if (BREACHED_PASSWORDS.includes(password.toLowerCase())) {
      throw weakPasswordException(PASSWORD_POLICY_MESSAGES.BREACHED);
    }
    const result = await evaluatePasswordPolicy(password, email, { logger: { warn: (m) => console.warn(m) }, minLength });
    if (result.ok === false) {
      throw weakPasswordException(result.message);
    }
  }

  /** bcrypt hash with cost 12 (shared by register, change password and password reset). */
  async hashPassword(password: string): Promise<string> {
    const salt = await bcrypt.genSalt(12);
    return bcrypt.hash(password, salt);
  }

  /**
   * Public Registration: strictly restricted to TEAM_CAPTAIN only.
   */
  async register(input: RegisterUserInput, ipAddress?: string) {
    const existing = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase() }
    });
    if (existing) {
      throw new ConflictException(
        'An account with this email address already exists. Please sign in or reset your password.'
      );
    }

    await this.validatePasswordPolicy(input.password, input.email);

    const passwordHash = await this.hashPassword(input.password);

    const user = await this.prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        passwordHash,
        fullName: input.fullName,
        role: Role.TEAM_CAPTAIN, // Strictly TEAM_CAPTAIN for public registration
        organization: input.organization || '',
        phone: input.phone || '',
        isPasswordTemporary: false,
        mustChangePassword: false,
        isTwoFactorEnabled: false,
        isActive: true
      }
    });

    const tokens = await this.createSession(user.id, ipAddress);
    return {
      user: this.sanitizeUser(user),
      ...tokens
    };
  }

  /**
   * Staff Provisioning: strictly restricted to SUPER_ADMIN.
   */
  async createStaffUser(
    adminUserId: string,
    input: { email: string; fullName: string; role: Role; organization?: string; phone?: string; tempPassword?: string },
    ipAddress?: string,
    userAgent?: string
  ) {
    const admin = await this.prisma.user.findUnique({ where: { id: adminUserId } });
    if (!admin || admin.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only Super Administrator can provision staff accounts');
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase() }
    });
    if (existing) {
      throw new ConflictException('User with this email already exists');
    }

    const tempPassword = input.tempPassword || (crypto.randomBytes(8).toString('base64').replace(/[^a-zA-Z0-9]/g, '') + 'A1!a' + crypto.randomBytes(4).toString('hex'));
    await this.validatePasswordPolicy(tempPassword, input.email, input.role);

    const passwordHash = await this.hashPassword(tempPassword);

    const user = await this.prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        passwordHash,
        fullName: input.fullName,
        role: input.role,
        organization: input.organization || 'GCDIS Technical Directorate',
        phone: input.phone || '',
        isPasswordTemporary: true,
        mustChangePassword: true,
        isTwoFactorEnabled: false,
        isActive: true,
        // Provisioned by a Super Administrator: the address is vouched for by the institution
        emailVerifiedAt: new Date()
      }
    });

    // Audit trail (never the password) and an alert when a new Super Administrator appears
    const actor: StaffManagementActor = { id: admin.id, email: admin.email, role: admin.role };
    await this.auditUserManagement('STAFF_USER_CREATED', actor, user, ipAddress, userAgent, {}, {
      role: user.role,
      fullName: user.fullName,
      temporaryPasswordIssued: true
    });
    if (user.role === Role.SUPER_ADMIN) {
      this.raiseAlert('SUPER_ADMIN_ROLE_GRANTED', user.email, {
        previousRole: null,
        context: 'staff-user-created',
        changedBy: admin.email || admin.id,
        ipAddress
      });
    }

    return {
      user: this.sanitizeUser(user),
      tempPassword
    };
  }

  /**
   * Authenticate user with dummy bcrypt timing defence, email+IP lockout backoff, and 2FA enforcement
   */
  async login(input: LoginInput, ipAddress: string = '127.0.0.1', userAgent?: string) {
    const email = input.email.toLowerCase();

    // Oversized passwords are refused before any hashing work (bcrypt DoS)
    if (typeof input.password !== 'string' || input.password.length > PASSWORD_MAX_LENGTH) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // 1. Lockout Check by Email + IP to prevent cross-user lockout DoS
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const failedAttempts = await this.prisma.loginAttempt.count({
      where: {
        email,
        ipAddress,
        successful: false,
        attemptedAt: { gte: fifteenMinutesAgo }
      }
    });

    if (failedAttempts >= LOGIN_LOCKOUT_THRESHOLD) {
      throw new ForbiddenException(
        'Too many failed login attempts for this account from your IP. Please try again in 15 minutes.'
      );
    }

    // IP-only flood protection for credential stuffing (50 attempts / 15 min)
    const failedAttemptsForIp = await this.prisma.loginAttempt.count({
      where: {
        ipAddress,
        successful: false,
        attemptedAt: { gte: fifteenMinutesAgo }
      }
    });

    if (failedAttemptsForIp >= 50) {
      throw new ForbiddenException(
        'Too many authentication requests from this IP address. Please try again in 15 minutes.'
      );
    }

    // Per-account soft lock across all IPs (distributed guessing against one account)
    const failedAttemptsForAccount = await this.countRecentAccountFailures(email);
    if (failedAttemptsForAccount >= ACCOUNT_SOFT_LOCK_THRESHOLD) {
      throw accountSoftLockException();
    }

    const user = await this.prisma.user.findUnique({ where: { email } });

    // 2. Dummy bcrypt comparison for non-existent users (constant-time response)
    if (!user) {
      await bcrypt.compare(input.password, DUMMY_HASH);
      await this.recordLoginAttempt(email, false, 'Invalid credentials', ipAddress);
      this.alertOnAccountSoftLock(email, failedAttemptsForAccount, ipAddress);
      throw new UnauthorizedException('Invalid email or password');
    }

    // The password is checked first for every account (also deactivated ones), so the response only
    // reveals that an account is deactivated to someone who knows its password
    const isMatch = await bcrypt.compare(input.password, user.passwordHash);
    if (!isMatch) {
      await this.recordLoginAttempt(email, false, 'Invalid credentials', ipAddress);
      if (failedAttempts + 1 >= LOGIN_LOCKOUT_THRESHOLD) {
        this.raiseAlert('ACCOUNT_LOCKOUT', email, { ipAddress, role: user.role, failedAttempts: failedAttempts + 1 });
      }
      this.alertOnAccountSoftLock(email, failedAttemptsForAccount, ipAddress, user.role);
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.isActive) {
      await this.recordLoginAttempt(email, false, 'Account deactivated', ipAddress);
      throw new UnauthorizedException('Account has been deactivated. Please contact support.');
    }

    // Record successful login
    await this.recordLoginAttempt(email, true, undefined, ipAddress);

    const isStaff = (ADMIN_ROLES as readonly Role[]).includes(user.role);

    // Optional staff network restriction (ADMIN_IP_ALLOWLIST), checked before any challenge is issued
    if (isStaff && !isAdminIpAllowed(ipAddress)) {
      await this.auditAuthEvent('AUTH_ADMIN_IP_DENIED', user, ipAddress, userAgent, { stage: 'login' });
      throw new ForbiddenException('Staff sign-in is not permitted from this network.');
    }

    // 3. 2FA Enforcement
    // A) Enrolled 2FA (Staff or Public) -> issue short-lived challenge token bound to user
    if (user.isTwoFactorEnabled) {
      const twoFactorState = await this.prisma.twoFactor.findUnique({ where: { userId: user.id } });
      const challengeToken = this.signChallengeToken(user.id, '2fa_challenge', '5m', {
        st: twoFactorStateFingerprint(twoFactorState)
      });

      return {
        requires2fa: true,
        mustEnroll2fa: false,
        challengeToken
      };
    }

    // B) Staff without 2FA -> issue enrolment-only challenge token
    if (isStaff && !user.isTwoFactorEnabled) {
      const challengeToken = this.signChallengeToken(user.id, '2fa_enrolment_challenge', '15m');

      return {
        requires2fa: true,
        mustEnroll2fa: true,
        challengeToken
      };
    }

    // C) Public Captain without 2FA -> regular login
    const tokens = await this.createSession(user.id, ipAddress, userAgent);
    await this.auditAuthEvent('AUTH_LOGIN_SUCCESS', user, ipAddress, userAgent, { method: 'password' });
    return {
      user: this.sanitizeUser(user),
      mustChangePassword: user.mustChangePassword,
      ...tokens
    };
  }

  /**
   * Verify TOTP or Recovery Code using the challenge token
   * Strictly requires challengeToken (never accepts userId from body)
   */
  async verify2faLogin(challengeToken: string, code: string, ipAddress?: string, userAgent?: string) {
    if (!challengeToken || typeof challengeToken !== 'string') {
      throw new UnauthorizedException('Missing 2FA challenge token');
    }
    if (!code || typeof code !== 'string') {
      throw new BadRequestException('Two-factor authentication code is required');
    }

    const payload = this.verifyChallengeToken(challengeToken);

    if (payload.type !== '2fa_challenge') {
      if (payload.type === '2fa_enrolment_challenge') {
        throw new BadRequestException('Two-factor authentication enrolment required. Enrol 2FA first before verifying login.');
      }
      throw new UnauthorizedException('Invalid 2FA challenge token type');
    }

    const userId = payload.sub;

    // Check per-user rate limit
    await this.twoFactorService.checkUserRateLimit(userId);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { twoFactor: true }
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or account deactivated');
    }

    if (!user.twoFactor || !user.twoFactor.isEnabled) {
      throw new BadRequestException('Two-factor authentication is not enrolled for this account');
    }

    // Single-use challenge (PT-03): the token is bound to the 2FA state at issue time, and every
    // successful sign-in changes that state, so a challenge cannot mint a second session
    if (payload.st !== twoFactorStateFingerprint(user.twoFactor)) {
      throw new UnauthorizedException('This sign-in request has already been used or has expired. Please sign in again.');
    }

    const decryptedSecret = this.twoFactorService.decryptSecret(user.twoFactor.secret);

    // Verify TOTP Code
    const totpResult = this.twoFactorService.verifyTotp(
      decryptedSecret,
      code,
      user.twoFactor.lastUsedStep
    );

    let isCodeValid = totpResult.isValid;

    // If TOTP failed, check Recovery Codes
    let updatedBackupCodes: any = null;
    let usedRecoveryCode = false;
    if (!isCodeValid && user.twoFactor.backupCodes) {
      const storedCodes = (user.twoFactor.backupCodes as any) || [];
      const recoveryResult = this.twoFactorService.verifyRecoveryCode(code, storedCodes);
      if (recoveryResult.isValid) {
        isCodeValid = true;
        usedRecoveryCode = true;
        updatedBackupCodes = recoveryResult.updatedRecords;
      }
    }

    if (!isCodeValid) {
      await this.twoFactorService.recordFailedAttempt(userId);
      if (await this.twoFactorService.isLocked?.(userId)) {
        this.raiseAlert('TWO_FACTOR_LOCKED', user.email, { ipAddress, role: user.role });
      }
      throw new UnauthorizedException('Invalid two-factor authentication code or recovery code');
    }

    // Claim the replay step / used recovery code with a compare-and-swap, so two concurrent
    // requests with the same code (or the same challenge) cannot both mint a session
    if (totpResult.matchedStep !== undefined) {
      const claimed = await this.prisma.twoFactor.updateMany({
        where: { userId, lastUsedStep: user.twoFactor.lastUsedStep },
        data: { lastUsedStep: totpResult.matchedStep }
      });
      if (claimed.count === 0) {
        throw new UnauthorizedException('This sign-in request has already been used or has expired. Please sign in again.');
      }
    } else if (updatedBackupCodes) {
      const claimed = await this.prisma.twoFactor.updateMany({
        where: { userId, backupCodes: { equals: user.twoFactor.backupCodes as any } },
        data: { backupCodes: updatedBackupCodes }
      });
      if (claimed.count === 0) {
        throw new UnauthorizedException('This sign-in request has already been used or has expired. Please sign in again.');
      }
    }

    // Success: clear the per-user failure counter
    await this.twoFactorService.clearUserAttempts(userId);

    if (usedRecoveryCode) {
      const remaining = Array.isArray(updatedBackupCodes)
        ? updatedBackupCodes.filter((r: any) => r && r.used === false).length
        : undefined;
      await this.auditAuthEvent('AUTH_RECOVERY_CODE_USED', user, ipAddress, userAgent, { remainingRecoveryCodes: remaining });
    }

    const tokens = await this.createSession(user.id, ipAddress, userAgent);
    await this.auditAuthEvent('AUTH_LOGIN_SUCCESS', user, ipAddress, userAgent, { method: 'password+2fa' });
    return {
      user: this.sanitizeUser(user),
      mustChangePassword: user.mustChangePassword,
      ...tokens
    };
  }

  /**
   * Generate 2FA Base32 Secret and QR/Auth URL for Enrollment
   * Strictly requires an enrolment challenge token (never accepts a raw userId)
   */
  async generate2faSecret(challengeToken: string) {
    const userId = this.resolveEnrolmentUserId(challengeToken);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { twoFactor: true }
    });
    if (!user || !user.isActive) throw new UnauthorizedException('User not found');
    if (user.isTwoFactorEnabled || user.twoFactor?.isEnabled) {
      throw new BadRequestException('Two-factor authentication is already enabled for this account');
    }

    // Reuse a pending (not yet confirmed) key, so signing in again or in another browser does not
    // silently invalidate an authenticator entry the user has already added
    let base32Secret: string | null = null;
    if (user.twoFactor?.secret) {
      try {
        base32Secret = this.twoFactorService.decryptSecret(user.twoFactor.secret);
      } catch {
        base32Secret = null;
      }
    }
    if (!base32Secret) {
      base32Secret = this.twoFactorService.generateBase32Secret();
      const encryptedSecret = this.twoFactorService.encryptSecret(base32Secret);
      await this.prisma.twoFactor.upsert({
        where: { userId },
        update: { secret: encryptedSecret, isEnabled: false },
        create: { userId, secret: encryptedSecret, isEnabled: false }
      });
    }

    const label = encodeURIComponent(`GCDIS:${user.email}`);
    const otpAuthUrl = `otpauth://totp/${label}?secret=${base32Secret}&issuer=GCDIS%20Championship&algorithm=SHA1&digits=6&period=30`;

    return { secret: base32Secret, otpAuthUrl };
  }

  /**
   * Confirm & Enable 2FA with 10 hashed recovery codes
   */
  async enable2fa(challengeToken: string, code: string, ipAddress?: string, userAgent?: string) {
    const userId = this.resolveEnrolmentUserId(challengeToken);
    if (!code || typeof code !== 'string') {
      throw new BadRequestException('Two-factor confirmation code is required');
    }
    const record = await this.prisma.twoFactor.findUnique({ where: { userId } });
    if (!record) throw new BadRequestException('No 2FA setup found. Generate a secret first.');
    if (record.isEnabled) {
      throw new BadRequestException('Two-factor authentication is already enabled for this account');
    }

    await this.twoFactorService.checkUserRateLimit(userId);

    const decryptedSecret = this.twoFactorService.decryptSecret(record.secret);
    const verifyResult = this.twoFactorService.verifyTotp(decryptedSecret, code);

    if (!verifyResult.isValid) {
      await this.twoFactorService.recordFailedAttempt(userId);
      throw new BadRequestException('Invalid two-factor confirmation code');
    }
    await this.twoFactorService.clearUserAttempts(userId);

    const { plaintextCodes, hashedRecords } = this.twoFactorService.generateRecoveryCodes();

    await this.prisma.$transaction([
      this.prisma.twoFactor.update({
        where: { userId },
        data: {
          isEnabled: true,
          isEnrolled: true,
          enrolledAt: new Date(),
          backupCodes: hashedRecords,
          lastUsedStep: verifyResult.matchedStep
        }
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { isTwoFactorEnabled: true }
      })
    ]);

    // Enrolment completes the login started by the challenge token: issue a session
    const sessionTokens = await this.createSession(userId, ipAddress, userAgent);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    await this.auditAuthEvent('AUTH_2FA_ENABLED', user ?? { id: userId }, ipAddress, userAgent, {
      method: 'TOTP',
      recoveryCodesIssued: plaintextCodes.length
    });

    return {
      success: true,
      message: 'Two-factor authentication successfully enabled',
      recoveryCodes: plaintextCodes,
      user: user ? this.sanitizeUser(user) : undefined,
      mustChangePassword: user?.mustChangePassword ?? false,
      ...sessionTokens
    };
  }

  /**
   * Force Password Change (server-side enforced)
   */
  async changePassword(userId: string, currentPass: string, newPass: string, ipAddress?: string, userAgent?: string) {
    if (typeof currentPass !== 'string' || currentPass.length > PASSWORD_MAX_LENGTH) {
      throw new UnauthorizedException('Current password does not match');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    // Wrong current passwords count toward the same lockouts as sign-in (per email + IP, and per account)
    const email = String(user.email || '').toLowerCase();
    const attemptIp = ipAddress || '127.0.0.1';
    let failedForIp = 0;
    try {
      failedForIp =
        Number(
          await this.prisma.loginAttempt.count({
            where: {
              email,
              ipAddress: attemptIp,
              successful: false,
              attemptedAt: { gte: new Date(Date.now() - 15 * 60 * 1000) }
            }
          })
        ) || 0;
    } catch {
      failedForIp = 0;
    }
    if (failedForIp >= LOGIN_LOCKOUT_THRESHOLD) {
      throw new ForbiddenException(
        'Too many failed password attempts for this account from your IP. Please try again in 15 minutes.'
      );
    }
    const failedForAccount = await this.countRecentAccountFailures(email);
    if (failedForAccount >= ACCOUNT_SOFT_LOCK_THRESHOLD) {
      throw accountSoftLockException();
    }

    await this.validatePasswordPolicy(newPass, user.email, user.role);

    const isMatch = await bcrypt.compare(currentPass, user.passwordHash);
    if (!isMatch) {
      await this.recordLoginAttempt(email, false, 'Change password: current password does not match', attemptIp);
      if (failedForIp + 1 >= LOGIN_LOCKOUT_THRESHOLD) {
        this.raiseAlert('ACCOUNT_LOCKOUT', email, {
          ipAddress: attemptIp,
          role: user.role,
          failedAttempts: failedForIp + 1,
          context: 'change-password'
        });
      }
      this.alertOnAccountSoftLock(email, failedForAccount, attemptIp, user.role);
      throw new UnauthorizedException('Current password does not match');
    }

    const passwordHash = await this.hashPassword(newPass);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        isPasswordTemporary: false,
        mustChangePassword: false
      }
    });

    // Revoke all existing sessions so old tokens cannot be used
    await this.prisma.session.updateMany({
      where: { userId },
      data: { revokedAt: new Date(), isActive: false }
    });

    await this.auditAuthEvent('AUTH_PASSWORD_CHANGED', user, ipAddress, userAgent, {
      wasTemporary: Boolean(user.isPasswordTemporary || user.mustChangePassword),
      sessionsRevoked: true
    });

    return { success: true, message: 'Password changed successfully' };
  }

  /**
   * Session & Refresh Token Rotation with Token Family Reuse Detection
   */
  async rotateSession(refreshToken: string, ipAddress?: string, userAgent?: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash },
      include: { user: true }
    });

    if (!session) {
      throw new UnauthorizedException('Invalid refresh session');
    }

    // Reuse Detection: If an already-revoked or inactive refresh token is presented,
    // an attacker has replayed a token! Immediately revoke the entire session family!
    if (session.revokedAt !== null || !session.isActive) {
      // Revoked by the server (idle timeout, concurrent session limit): not a replay
      const revokedReason = (session as any).revokedReason;
      if (revokedReason === REVOKED_IDLE_TIMEOUT) throw sessionIdleTimeoutException();
      if (revokedReason === REVOKED_SESSION_LIMIT) throw sessionLimitRevokedException();

      // Benign race: two tabs of the same browser refreshed with the same cookie. The other request
      // rotated this token moments ago and its successor is live, so the browser already holds the
      // new cookies. Answer 409 without revoking the family; the client simply retries its request.
      if (await this.wasJustRotated(session)) {
        throw new ConflictException('This session was refreshed by another request. Please retry.');
      }

      await this.prisma.session.updateMany({
        where: {
          familyId: session.familyId || session.id
        },
        data: { revokedAt: new Date(), isActive: false }
      });

      // Alert only on a genuine replay: the token had been rotated (a successor exists in the family).
      // A token of a session ended by sign-out, password change or reset is merely stale.
      if (this.securityAlerts && (await this.hadSuccessor(session))) {
        this.raiseAlert('REFRESH_TOKEN_REPLAY', (session as any).user?.email || session.userId, {
          ipAddress,
          role: (session as any).user?.role,
          familyId: session.familyId || session.id
        });
      }

      throw new UnauthorizedException(
        'Refresh token reuse detected. All sessions in this security family have been revoked.'
      );
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh session expired');
    }

    // Staff idle timeout: a refresh after too long without activity ends the session family
    const isStaffSession = isStaffRoleValue((session as any).user?.role);
    if (isStaffSession && isSessionIdle(session as any)) {
      await this.revokeIdleFamily(session as any, ipAddress, userAgent);
      throw sessionIdleTimeoutException();
    }

    // Revoke current session (conditional, so two simultaneous refreshes cannot both rotate it)
    const revoked = await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null, isActive: true },
      data: { revokedAt: new Date(), isActive: false }
    });
    if (revoked.count === 0) {
      throw new ConflictException('This session was refreshed by another request. Please retry.');
    }

    // Issue next session in the same family. Staff sessions keep their absolute expiry and the
    // step-up window travels with the session; lastUsedAt records the refresh.
    return this.createSession(session.userId, ipAddress, userAgent, session.familyId || session.id, {
      expiresAt: session.expiresAt,
      stepUpAt: (session as any).stepUpAt ?? null,
      rotated: true,
      ...(isStaffSession ? { lastSeenAt: new Date(sessionLastActivity(session as any)) } : {})
    });
  }

  /** Revokes an idle staff session family (reason IDLE_TIMEOUT) and records it in the audit log. */
  private async revokeIdleFamily(
    session: { id: string; userId: string; familyId: string | null; user?: { email?: string; role?: string } },
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    const familyId = session.familyId || session.id;
    const revoked = await this.prisma.session.updateMany({
      where: { userId: session.userId, OR: [{ id: session.id }, { familyId }], revokedAt: null },
      data: { revokedAt: new Date(), isActive: false, revokedReason: REVOKED_IDLE_TIMEOUT }
    });
    await this.auditAuthEvent(
      'AUTH_SESSION_IDLE_TIMEOUT',
      { id: session.userId, email: session.user?.email, role: session.user?.role },
      ipAddress,
      userAgent,
      {
        sessionId: session.id,
        idleTimeoutMinutes: adminIdleTimeoutMinutes(),
        sessionsRevoked: Number((revoked as any)?.count ?? 0),
        stage: 'refresh'
      }
    );
  }

  /** Grace period in which a just-rotated refresh token is treated as a concurrent tab, not a replay. */
  private static readonly REFRESH_RACE_GRACE_MS = 20_000;

  /**
   * True when this revoked session was rotated (not signed out) within the grace period: a live
   * successor exists in the same family, created at or after the revocation.
   */
  private async wasJustRotated(session: { id: string; familyId: string | null; revokedAt: Date | null }) {
    if (!session.revokedAt) return false;
    if (Date.now() - session.revokedAt.getTime() > AuthService.REFRESH_RACE_GRACE_MS) return false;
    const successor = await this.prisma.session.findFirst({
      where: {
        familyId: session.familyId || session.id,
        id: { not: session.id },
        isActive: true,
        revokedAt: null,
        createdAt: { gte: new Date(session.revokedAt.getTime() - 1000) }
      },
      select: { id: true }
    });
    return successor !== null;
  }

  /**
   * Revoke Session on Logout (immediate session invalidation)
   */
  async logout(refreshToken?: string, sessionId?: string) {
    if (refreshToken) {
      const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await this.prisma.session.updateMany({
        where: { refreshTokenHash },
        data: { revokedAt: new Date(), isActive: false }
      });
    }

    if (sessionId) {
      await this.prisma.session.updateMany({
        where: { id: sessionId },
        data: { revokedAt: new Date(), isActive: false }
      });
    }

    return { success: true, message: 'Session logged out' };
  }

  /**
   * Session id (sid) of a correctly signed access token, even an expired one; null otherwise. Used by
   * sign-out, which must work without a live access token: a valid signature proves the token was
   * issued by us for that session, so revoking that session is always safe.
   */
  sessionIdFromAccessToken(token?: string | null): string | null {
    if (!token || typeof token !== 'string') return null;
    try {
      const decoded: any = this.jwtService.decode(token);
      const audience = decoded?.aud === 'gcdis-admin' ? 'gcdis-admin' : 'gcdis-public';
      const secret = audience === 'gcdis-admin' ? getAdminJwtSecret() : getPublicJwtSecret();
      const payload: any = this.jwtService.verify(token, {
        secret,
        audience,
        algorithms: JWT_ALGORITHMS,
        ignoreExpiration: true
      });
      if (!payload?.sid || payload.type !== undefined) return null;
      return String(payload.sid);
    } catch {
      return null;
    }
  }

  /**
   * Revoke all sessions for a user
   */
  async logoutAll(
    userId: string,
    actor?: { email?: string | null; role?: string | null; ipAddress?: string; userAgent?: string }
  ) {
    const revoked = await this.prisma.session.updateMany({
      where: { userId },
      data: { revokedAt: new Date(), isActive: false }
    });
    await this.auditAuthEvent(
      'AUTH_LOGOUT_ALL',
      { id: userId, email: actor?.email, role: actor?.role },
      actor?.ipAddress,
      actor?.userAgent,
      { sessionsRevoked: (revoked as any)?.count }
    );
    return { success: true, message: 'All active sessions revoked' };
  }

  /**
   * Step-up re-authentication (POST /auth/step-up): a current TOTP code (replay-protected through
   * lastUsedStep) or an unused recovery code (consumed) opens a 10-minute window on the calling session.
   */
  async stepUp(
    actor: { id: string; sid?: string },
    code: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ stepUpUntil: string }> {
    if (!actor?.id || !actor.sid) {
      throw new UnauthorizedException('Authentication required');
    }
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw new BadRequestException('code is required');
    }
    const userId = actor.id;

    try {
      await this.twoFactorService.checkUserRateLimit(userId);
    } catch (err: any) {
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, code: 'STEP_UP_LOCKED', message: err?.message || 'Too many failed attempts.' },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { twoFactor: true } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or account deactivated');
    }
    if (!user.isTwoFactorEnabled || !user.twoFactor || !user.twoFactor.isEnabled) {
      throw new BadRequestException({
        code: 'TWO_FACTOR_NOT_ENABLED',
        message: 'Two-factor authentication is not enabled for this account.'
      });
    }

    const trimmed = code.trim();
    let method: 'TOTP' | 'RECOVERY_CODE' | null = null;
    let remainingRecoveryCodes: number | undefined;

    // 1. TOTP with replay protection: the step must be newer than the last accepted one, and the
    //    conditional update makes two concurrent requests with the same code fail closed.
    const secret = this.twoFactorService.decryptSecret(user.twoFactor.secret);
    const totp = this.twoFactorService.verifyTotp(secret, trimmed, user.twoFactor.lastUsedStep);
    if (totp.isValid && totp.matchedStep !== undefined) {
      const claimed = await this.prisma.twoFactor.updateMany({
        where: {
          userId,
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: totp.matchedStep } }]
        },
        data: { lastUsedStep: totp.matchedStep }
      });
      if (claimed.count === 1) method = 'TOTP';
    }

    // 2. Recovery code (single use; consumed with a compare-and-swap on the stored records)
    if (!method && user.twoFactor.backupCodes) {
      const stored = (user.twoFactor.backupCodes as any) || [];
      const recovery = this.twoFactorService.verifyRecoveryCode(trimmed, stored);
      if (recovery.isValid && recovery.updatedRecords) {
        const claimed = await this.prisma.twoFactor.updateMany({
          where: { userId, backupCodes: { equals: stored } },
          data: { backupCodes: recovery.updatedRecords as any }
        });
        if (claimed.count === 1) {
          method = 'RECOVERY_CODE';
          remainingRecoveryCodes = recovery.updatedRecords.filter((r) => r && r.used === false).length;
        }
      }
    }

    if (!method) {
      await this.twoFactorService.recordFailedAttempt(userId);
      if (await this.twoFactorService.isLocked?.(userId)) {
        this.raiseAlert('STEP_UP_LOCKED', user.email, { ipAddress, role: user.role, sessionId: actor.sid });
      }
      await this.auditAuthEvent('AUTH_STEP_UP_FAILED', user, ipAddress, userAgent, { sessionId: actor.sid });
      throw new BadRequestException({
        code: 'INVALID_STEP_UP_CODE',
        message: 'The authentication code is not valid. Enter a new code from your authenticator app.'
      });
    }

    await this.twoFactorService.clearUserAttempts(userId);
    const now = new Date();
    const updated = await this.prisma.session.updateMany({
      where: { id: actor.sid, userId, isActive: true, revokedAt: null },
      data: { stepUpAt: now }
    });
    if (updated.count !== 1) {
      throw new UnauthorizedException('Session has been revoked or expired');
    }

    await this.auditAuthEvent('AUTH_STEP_UP_SUCCESS', user, ipAddress, userAgent, { method, sessionId: actor.sid });
    if (method === 'RECOVERY_CODE') {
      await this.auditAuthEvent('AUTH_RECOVERY_CODE_USED', user, ipAddress, userAgent, {
        remainingRecoveryCodes,
        context: 'step-up'
      });
    }

    return { stepUpUntil: new Date(now.getTime() + STEP_UP_WINDOW_MS).toISOString() };
  }

  /**
   * The caller's own active sessions (GET /auth/sessions). Each refresh rotates the session row, so
   * createdAt is the sign-in time of the session family and lastUsedAt the latest refresh.
   */
  async listSessions(userId: string, currentSessionId?: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId, isActive: true, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        familyId: true,
        createdAt: true,
        lastUsedAt: true,
        ipAddress: true,
        userAgent: true
      }
    });

    const families = Array.from(new Set(sessions.map((s) => s.familyId).filter((f): f is string => !!f)));
    const familyStart = new Map<string, Date>();
    if (families.length > 0) {
      const groups = await this.prisma.session.groupBy({
        by: ['familyId'],
        where: { userId, familyId: { in: families } },
        _min: { createdAt: true }
      });
      for (const g of groups as any[]) {
        if (g.familyId && g._min?.createdAt) familyStart.set(g.familyId, g._min.createdAt);
      }
    }

    return sessions.map((s) => ({
      id: s.id,
      createdAt: (s.familyId && familyStart.get(s.familyId)) || s.createdAt,
      lastUsedAt: s.lastUsedAt ?? null,
      ipAddress: s.ipAddress ?? null,
      userAgent: s.userAgent ?? null,
      current: !!currentSessionId && s.id === currentSessionId
    }));
  }

  /**
   * Revokes one of the caller's own sessions (DELETE /auth/sessions/:id), including its whole refresh
   * family. Revoking any session other than the current one requires a recent step-up when the account
   * has two-factor authentication (always the case for staff).
   */
  async revokeSession(
    actor: { id: string; sid?: string; email?: string; role?: string },
    sessionId: string,
    hasStepUp: boolean,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ success: true; current: boolean }> {
    const target = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, familyId: true, isActive: true, revokedAt: true, expiresAt: true }
    });
    if (!target || target.userId !== actor.id || !target.isActive || target.revokedAt || target.expiresAt < new Date()) {
      throw new NotFoundException('Session not found');
    }

    const isCurrent = !!actor.sid && target.id === actor.sid;
    if (!isCurrent && !hasStepUp) {
      const owner = await this.prisma.user.findUnique({ where: { id: actor.id }, select: { isTwoFactorEnabled: true } });
      if (owner?.isTwoFactorEnabled) {
        throw stepUpRequiredException();
      }
    }

    const familyId = target.familyId || target.id;
    const revoked = await this.prisma.session.updateMany({
      where: { userId: actor.id, OR: [{ id: target.id }, { familyId }], revokedAt: null },
      data: { revokedAt: new Date(), isActive: false }
    });

    await this.auditAuthEvent(
      'AUTH_SESSION_REVOKED',
      { id: actor.id, email: actor.email, role: actor.role },
      ipAddress,
      userAgent,
      { sessionId: target.id, current: isCurrent, rowsRevoked: (revoked as any)?.count }
    );

    return { success: true, current: isCurrent };
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user ? this.sanitizeUser(user) : null;
  }

  async findAllUsers(
    page: { take: number; skip: number } = { take: 100, skip: 0 },
    scope: boolean | UsersScope = false,
    search?: string,
    filters: UsersFilters = {}
  ) {
    const users = await this.prisma.user.findMany({
      where: this.usersWhere(scope, search, filters),
      orderBy: { createdAt: 'desc' },
      take: page.take,
      skip: page.skip,
      ...(scope === 'captains' ? { include: CAPTAIN_TEAMS_INCLUDE } : {})
    });
    return users.map((u) => this.sanitizeListedUser(u));
  }

  /** Paged user listing with the total row count for the same filter (GET /auth/users?withMeta=true). */
  async findUsersWithTotal(
    page: { take: number; skip: number },
    scope: boolean | UsersScope = false,
    search?: string,
    filters: UsersFilters = {}
  ) {
    const where = this.usersWhere(scope, search, filters);
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: page.take,
        skip: page.skip,
        ...(scope === 'captains' ? { include: CAPTAIN_TEAMS_INCLUDE } : {})
      }),
      this.prisma.user.count({ where })
    ]);
    return { items: users.map((u) => this.sanitizeListedUser(u)), total };
  }

  /**
   * Active team captains whose email address is not verified (GET /auth/captains/awaiting-verification),
   * with their teams and whether a registration exists: these captains cannot submit a registration or
   * pay, so their teams never appear among the registrations until the address is verified.
   */
  async findCaptainsAwaitingVerification(page: { take: number; skip: number }, search?: string) {
    return this.findUsersWithTotal(page, 'captains', search, { verified: false, activeOnly: true });
  }

  /** Captain listings carry their teams as { id, name, code, registrationCount }. */
  private sanitizeListedUser(user: any) {
    const { teamsLed, ...rest } = user;
    const base = this.sanitizeUser(rest);
    if (!Array.isArray(teamsLed)) return base;
    return {
      ...base,
      teams: teamsLed.map((t: any) => ({
        id: t.id,
        name: t.name,
        code: t.code,
        createdAt: t.createdAt,
        registrationCount: Number(t._count?.registrations ?? 0)
      }))
    };
  }

  /**
   * scope=staff limits the listing to SUPER_ADMIN, EVENT_ADMIN, JUDGE and INSPECTOR accounts;
   * scope=captains to team captain accounts. search matches the email address or the name;
   * verified=true/false filters on the email verification status.
   */
  private usersWhere(scope: boolean | UsersScope, search?: string, filters: UsersFilters = {}): Prisma.UserWhereInput | undefined {
    const resolved: UsersScope = scope === true ? 'staff' : scope === false ? 'all' : scope;
    const clauses: Prisma.UserWhereInput[] = [];
    if (resolved === 'staff') clauses.push({ role: { in: [...ADMIN_ROLES] as Role[] } });
    if (resolved === 'captains') clauses.push({ role: Role.TEAM_CAPTAIN });
    const term = typeof search === 'string' ? search.trim().slice(0, 254) : '';
    if (term) {
      clauses.push({
        OR: [
          { email: { contains: term, mode: 'insensitive' } },
          { fullName: { contains: term, mode: 'insensitive' } }
        ]
      });
    }
    if (filters.verified === true) clauses.push({ emailVerifiedAt: { not: null } });
    if (filters.verified === false) clauses.push({ emailVerifiedAt: null });
    if (filters.activeOnly) clauses.push({ isActive: true });
    if (clauses.length === 0) return undefined;
    return clauses.length === 1 ? clauses[0] : { AND: clauses };
  }

  /**
   * Changes a staff member's role (PATCH /auth/users/:id/role, Super Administrator with step-up).
   * Staff roles only; a participant account never becomes staff and staff never becomes a participant.
   * The caller cannot change their own role and the last active Super Administrator cannot be demoted.
   * All of the target's sessions are revoked so that the new role takes effect on the next sign-in.
   */
  async changeUserRole(
    actor: StaffManagementActor,
    targetId: string,
    requestedRole: string,
    ipAddress?: string,
    userAgent?: string
  ) {
    if (!(Object.values(Role) as string[]).includes(requestedRole)) {
      throw staffManagementError(
        'INVALID_ROLE',
        'The requested role is not recognised. Select Super Administrator, Event Administrator, Judge or Technical Inspector.'
      );
    }
    const newRole = requestedRole as Role;
    if (actor.id === targetId) {
      throw staffManagementError('SELF_MODIFICATION_NOT_ALLOWED', 'You cannot change the role of your own account.');
    }

    const result = await this.runStaffManagementTransaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: targetId } });
      if (!target) throw new NotFoundException('The requested account could not be found.');
      if (!isStaffRoleValue(target.role)) {
        throw staffManagementError(
          'ROLE_BOUNDARY',
          'The role of a participant account cannot be changed to a staff role. Staff accounts must be created through staff provisioning.'
        );
      }
      if (!isStaffRoleValue(newRole)) {
        throw staffManagementError(
          'ROLE_BOUNDARY',
          'A staff account cannot be changed to a participant role. Deactivate the account instead.'
        );
      }
      if (target.role === newRole) {
        throw staffManagementError('ROLE_UNCHANGED', 'The account already holds the selected role.');
      }
      if (target.role === Role.SUPER_ADMIN && target.isActive) {
        await this.assertAnotherActiveSuperAdmin(tx, target.id);
      }

      const updated = await tx.user.update({ where: { id: target.id }, data: { role: newRole } });
      const revoked = await tx.session.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: new Date(), isActive: false }
      });
      return { before: target, updated, sessionsRevoked: Number((revoked as any)?.count ?? 0) };
    });

    await this.auditUserManagement('STAFF_ROLE_CHANGED', actor, result.updated, ipAddress, userAgent, { role: result.before.role }, {
      role: result.updated.role,
      sessionsRevoked: result.sessionsRevoked
    });
    if (newRole === Role.SUPER_ADMIN) {
      this.raiseAlert('SUPER_ADMIN_ROLE_GRANTED', result.updated.email, {
        previousRole: result.before.role,
        changedBy: actor.email || actor.id,
        ipAddress
      });
    }
    if (result.before.role === Role.SUPER_ADMIN && newRole !== Role.SUPER_ADMIN) {
      this.raiseAlert('SUPER_ADMIN_ROLE_REVOKED', result.updated.email, {
        newRole,
        changedBy: actor.email || actor.id,
        ipAddress
      });
    }

    return this.sanitizeUser(result.updated);
  }

  /**
   * Deactivates or reactivates an account (PATCH /auth/users/:id/status, Super Administrator with
   * step-up). Participant accounts may be deactivated for moderation. The caller cannot change their
   * own status and the last active Super Administrator cannot be deactivated. Deactivation revokes
   * every session of the account immediately.
   */
  async setUserActiveStatus(
    actor: StaffManagementActor,
    targetId: string,
    isActive: boolean,
    reason?: string,
    ipAddress?: string,
    userAgent?: string
  ) {
    if (actor.id === targetId) {
      throw staffManagementError('SELF_MODIFICATION_NOT_ALLOWED', 'You cannot change the status of your own account.');
    }
    const cleanReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : undefined;

    const result = await this.runStaffManagementTransaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: targetId } });
      if (!target) throw new NotFoundException('The requested account could not be found.');
      if (target.isActive === isActive) {
        throw staffManagementError(
          'STATUS_UNCHANGED',
          isActive ? 'The account is already active.' : 'The account is already deactivated.'
        );
      }
      if (!isActive && target.role === Role.SUPER_ADMIN) {
        await this.assertAnotherActiveSuperAdmin(tx, target.id);
      }

      const updated = await tx.user.update({ where: { id: target.id }, data: { isActive } });
      let sessionsRevoked = 0;
      if (!isActive) {
        const revoked = await tx.session.updateMany({
          where: { userId: target.id, revokedAt: null },
          data: { revokedAt: new Date(), isActive: false }
        });
        sessionsRevoked = Number((revoked as any)?.count ?? 0);
      }
      return { updated, sessionsRevoked };
    });

    const staff = isStaffRoleValue(result.updated.role);
    await this.auditUserManagement(
      isActive ? 'USER_REACTIVATED' : 'USER_DEACTIVATED',
      actor,
      result.updated,
      ipAddress,
      userAgent,
      { isActive: !isActive },
      {
        isActive,
        role: result.updated.role,
        accountType: staff ? 'STAFF' : 'PARTICIPANT',
        reason: cleanReason ?? null,
        ...(isActive ? {} : { sessionsRevoked: result.sessionsRevoked })
      }
    );
    if (!isActive && result.updated.role === Role.SUPER_ADMIN) {
      this.raiseAlert('SUPER_ADMIN_ROLE_REVOKED', result.updated.email, {
        context: 'account-deactivated',
        changedBy: actor.email || actor.id,
        ipAddress
      });
    }
    if (!isActive && staff) {
      this.raiseAlert('STAFF_ACCOUNT_DEACTIVATED', result.updated.email, {
        role: result.updated.role,
        deactivatedBy: actor.email || actor.id,
        reason: cleanReason,
        ipAddress
      });
    }

    return this.sanitizeUser(result.updated);
  }

  /** Serializable transaction so two concurrent demotions cannot remove the last Super Administrator. */
  private async runStaffManagementTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (err: any) {
      if (err?.code === 'P2034') {
        throw new ConflictException({
          statusCode: 409,
          code: 'CONCURRENT_UPDATE',
          message: 'The account was changed by another request. Please reload the list and try again.'
        });
      }
      throw err;
    }
  }

  private async assertAnotherActiveSuperAdmin(tx: Prisma.TransactionClient, excludeUserId: string): Promise<void> {
    const others = await tx.user.count({
      where: { role: Role.SUPER_ADMIN, isActive: true, id: { not: excludeUserId } }
    });
    if (others < 1) {
      throw new ConflictException({
        statusCode: 409,
        code: 'LAST_SUPER_ADMIN',
        message: 'This is the last active Super Administrator account. Assign the Super Administrator role to another account first.'
      });
    }
  }

  /** Public wrapper so collaborating services (email verification administration) share one audit format. */
  async recordUserManagementEvent(
    action: UserManagementAuditAction,
    actor: StaffManagementActor,
    target: { id: string; email: string },
    ipAddress: string | undefined,
    userAgent: string | undefined,
    beforeState: Record<string, unknown>,
    afterState: Record<string, unknown>
  ) {
    await this.auditUserManagement(action, actor, target, ipAddress, userAgent, beforeState, afterState);
  }

  /** Audit entry for a user-management action; the target account is the audited entity. */
  private async auditUserManagement(
    action: UserManagementAuditAction,
    actor: StaffManagementActor,
    target: { id: string; email: string },
    ipAddress: string | undefined,
    userAgent: string | undefined,
    beforeState: Record<string, unknown>,
    afterState: Record<string, unknown>
  ) {
    const entry = {
      actorId: actor.id,
      actorEmail: actor.email ?? undefined,
      actorRole: actor.role ?? undefined,
      action,
      entityType: 'User',
      entityId: target.id,
      beforeState,
      afterState: { targetEmail: target.email, ...afterState },
      ipAddress,
      userAgent
    };
    try {
      if (this.auditService) {
        await this.auditService.logAction(entry);
      } else if ((this.prisma as any).auditLog?.create) {
        await appendAuditLog(this.prisma, { ...entry, ipAddress: ipAddress || '127.0.0.1', userAgent: userAgent || 'Unknown' });
      }
    } catch {
      // Non-fatal: the change itself has already been committed
    }
  }

  /**
   * Issues a session for a user already authenticated by an external identity provider
   * (Sign in with Google). Callers must have enforced role / 2FA policy; staff are refused here too.
   */
  async issueSessionForUser(user: { id: string; role: Role; mustChangePassword: boolean }, ipAddress?: string, userAgent?: string) {
    if ((ADMIN_ROLES as readonly Role[]).includes(user.role)) {
      throw new ForbiddenException('Staff accounts must sign in with two-factor authentication.');
    }
    const tokens = await this.createSession(user.id, ipAddress, userAgent);
    return {
      user: this.sanitizeUser(user),
      mustChangePassword: user.mustChangePassword,
      ...tokens
    };
  }

  // --- Internal Session & Token Helpers ---

  private async createSession(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
    familyId?: string,
    carry?: SessionCarryOver
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw new UnauthorizedException('User not found or inactive');

    const isStaff = (ADMIN_ROLES as readonly Role[]).includes(user.role);
    if (isStaff) {
      // Defence in depth: a staff session is never issued without enrolled two-factor authentication
      if (!user.isTwoFactorEnabled) {
        throw new ForbiddenException('Two-factor authentication must be enabled before a staff session can be issued.');
      }
      if (!isAdminIpAllowed(ipAddress)) {
        await this.auditAuthEvent('AUTH_ADMIN_IP_DENIED', user, ipAddress, userAgent, {
          stage: carry?.rotated ? 'refresh' : 'session'
        });
        throw new ForbiddenException('Staff sign-in is not permitted from this network.');
      }
    }
    // New device / location for staff sign-ins (not for refresh rotation). Checked before this session is stored.
    if (isStaff && !carry?.rotated) {
      await this.notifyIfNewStaffDevice(user, ipAddress, userAgent);
    }

    const audience = isStaff ? 'gcdis-admin' : 'gcdis-public';
    // Shared derivation with JwtStrategy (JWT_ADMIN_SECRET mandatory in production)
    const secret = isStaff ? getAdminJwtSecret() : getPublicJwtSecret();

    const sessionId = crypto.randomUUID();
    const sessionFamily = familyId || crypto.randomUUID();

    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
      aud: audience,
      sid: sessionId,
      mustChangePassword: user.mustChangePassword
    };

    // 5-10 min short-lived access token
    const accessToken = this.jwtService.sign(payload, {
      expiresIn: '10m',
      secret
    });

    const rawRefreshToken = crypto.randomBytes(40).toString('hex');
    const refreshTokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    // Staff: absolute lifetime (ADMIN_SESSION_MAX_HOURS, default 12h) never extended by rotation.
    // Public: 7-day sliding lifetime (unchanged).
    const now = Date.now();
    let expiresAt: Date;
    if (isStaff) {
      const cap = new Date(now + adminSessionMaxMs());
      const inherited = carry?.expiresAt ? new Date(carry.expiresAt) : null;
      expiresAt = inherited && inherited.getTime() < cap.getTime() ? inherited : cap;
    } else {
      expiresAt = new Date(now + PUBLIC_SESSION_MS);
    }

    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        familyId: sessionFamily,
        refreshTokenHash,
        ipAddress: ipAddress || '127.0.0.1',
        userAgent: userAgent || 'Unknown',
        expiresAt,
        isActive: true,
        ...(carry?.stepUpAt ? { stepUpAt: carry.stepUpAt } : {}),
        ...(carry?.rotated ? { lastUsedAt: new Date(now) } : {}),
        // Staff: the idle clock starts at sign-in and is carried over by refresh rotation
        ...(isStaff ? { lastSeenAt: carry?.lastSeenAt ? new Date(carry.lastSeenAt) : new Date(now) } : {})
      }
    });

    // Concurrent staff sessions (ADMIN_MAX_SESSIONS): a new sign-in signs out the oldest sessions
    if (isStaff && !carry?.rotated) {
      await this.enforceStaffSessionLimit(user, sessionId, ipAddress, userAgent);
    }

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      sessionId,
      audience,
      refreshExpiresAt: expiresAt
    };
  }

  /**
   * 2FA challenge tokens use a dedicated audience and a key derived from JWT_SECRET,
   * so they can never be verified as access tokens (and vice versa).
   */
  private challengeSecret(): string {
    return getChallengeJwtSecret();
  }

  private signChallengeToken(
    userId: string,
    type: ChallengeType,
    expiresIn: JwtSignOptions['expiresIn'],
    extra: Record<string, string> = {}
  ): string {
    return this.jwtService.sign(
      { sub: userId, type, ...extra },
      { secret: this.challengeSecret(), audience: CHALLENGE_AUDIENCE, expiresIn }
    );
  }

  private verifyChallengeToken(token: string): { sub: string; type: ChallengeType; st?: string } {
    try {
      const payload: any = this.jwtService.verify(token, {
        secret: this.challengeSecret(),
        audience: CHALLENGE_AUDIENCE,
        algorithms: JWT_ALGORITHMS
      });
      if (!payload?.sub) throw new Error('missing subject');
      return payload;
    } catch (err) {
      throw new UnauthorizedException('Invalid or expired 2FA challenge token');
    }
  }

  private resolveEnrolmentUserId(challengeToken: string): string {
    if (!challengeToken || typeof challengeToken !== 'string') {
      throw new UnauthorizedException('Missing 2FA enrolment challenge token');
    }
    const payload = this.verifyChallengeToken(challengeToken);
    if (payload.type !== '2fa_enrolment_challenge') {
      throw new UnauthorizedException('Invalid 2FA challenge token type');
    }
    return payload.sub;
  }

  /** Failed sign-ins (and wrong current-password checks) for an email address from any IP in the last hour. */
  private async countRecentAccountFailures(email: string): Promise<number> {
    try {
      const n = await this.prisma.loginAttempt.count({
        where: {
          email,
          successful: false,
          attemptedAt: { gte: new Date(Date.now() - ACCOUNT_SOFT_LOCK_WINDOW_MS) }
        }
      });
      return Number(n) || 0;
    } catch {
      return 0;
    }
  }

  /** Raises ACCOUNT_LOCKOUT (scope: account) when this failure is the one that soft-locks the account. */
  private alertOnAccountSoftLock(email: string, failuresBefore: number, ipAddress?: string, role?: string) {
    if (failuresBefore + 1 >= ACCOUNT_SOFT_LOCK_THRESHOLD) {
      this.raiseAlert('ACCOUNT_LOCKOUT', `${email}|account`, {
        scope: 'account',
        email,
        role,
        ipAddress,
        failedAttempts: failuresBefore + 1,
        windowMinutes: ACCOUNT_SOFT_LOCK_WINDOW_MS / 60000
      });
    }
  }

  async recordLoginAttempt(
    email: string,
    successful: boolean,
    failureReason?: string,
    ipAddress?: string
  ) {
    try {
      await this.prisma.loginAttempt.create({
        data: {
          email,
          successful,
          failureReason,
          ipAddress: ipAddress || '127.0.0.1'
        }
      });
    } catch (e) {
      // Non-fatal
    }
  }

  /** True when a later session of the same family was issued at or after this one was revoked (rotation). */
  private async hadSuccessor(session: { id: string; familyId: string | null; revokedAt: Date | null }): Promise<boolean> {
    try {
      if (!session.revokedAt) return false;
      const successor = await this.prisma.session.findFirst({
        where: {
          familyId: session.familyId || session.id,
          id: { not: session.id },
          createdAt: { gte: new Date(session.revokedAt.getTime() - 1000) }
        },
        select: { id: true }
      });
      return successor !== null;
    } catch {
      return false;
    }
  }

  /**
   * Staff sign-in from a network (/24, IPv6 /64) or a browser family (e.g. "Chrome on Windows") absent from the
   * account's sessions of the last 30 days: raises STAFF_NEW_DEVICE_LOGIN and emails the staff member a notice.
   * Never fails the sign-in (lookup errors skip the check).
   */
  private async notifyIfNewStaffDevice(
    user: { id: string; email: string; role: Role | string; fullName?: string | null },
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    let history: Array<{ ipAddress: string | null; userAgent: string | null }>;
    try {
      const since = new Date(Date.now() - STAFF_DEVICE_HISTORY_DAYS * 24 * 60 * 60 * 1000);
      history = await this.prisma.session.findMany({
        where: { userId: user.id, createdAt: { gte: since } },
        select: { ipAddress: true, userAgent: true },
        orderBy: { createdAt: 'desc' },
        take: 500
      });
      if (!Array.isArray(history)) return;
    } catch {
      return;
    }
    const network = ipNetworkOf(ipAddress || '127.0.0.1');
    const browser = userAgentFamily(userAgent);
    const newNetwork = !history.some((h) => ipNetworkOf(h.ipAddress || '127.0.0.1') === network);
    const newBrowser = !history.some((h) => userAgentFamily(h.userAgent) === browser);
    if (!newNetwork && !newBrowser) return;

    this.raiseAlert('STAFF_NEW_DEVICE_LOGIN', `${user.email}|${network}|${browser}`, {
      email: user.email,
      role: user.role,
      ipAddress,
      network,
      browser,
      newNetwork,
      newBrowser,
      userAgent
    });
    await this.auditAuthEvent('AUTH_NEW_DEVICE_SIGN_IN', user as any, ipAddress, userAgent, { network, browser, newNetwork, newBrowser });
    if (this.mail) {
      const content = staffNewSignInNotice(user.fullName, { time: new Date(), ipAddress: ipAddress || 'Unknown', browser });
      void this.mail.sendSafe({ to: user.email, ...content, logLabel: 'Staff new sign-in notice' }).catch(() => undefined);
    }
  }

  /**
   * Caps concurrent staff sessions (ADMIN_MAX_SESSIONS, default 3): after a new sign-in, the oldest active
   * session families beyond the cap are revoked (reason SESSION_LIMIT), audited and alerted. Best effort:
   * a lookup error never fails the sign-in.
   */
  private async enforceStaffSessionLimit(
    user: { id: string; email: string; role: Role | string },
    newSessionId: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<void> {
    try {
      const max = adminMaxSessions();
      const active: Array<{ id: string; familyId: string | null; createdAt: Date }> = await this.prisma.session.findMany({
        where: { userId: user.id, isActive: true, revokedAt: null, expiresAt: { gt: new Date() }, id: { not: newSessionId } },
        select: { id: true, familyId: true, createdAt: true }
      });
      if (!Array.isArray(active)) return;
      // One live row per family; the family's sign-in time is its earliest row
      const families = new Map<string, { familyId: string; startedAt: number }>();
      for (const row of active) {
        const familyId = row.familyId || row.id;
        const startedAt = new Date(row.createdAt).getTime();
        const known = families.get(familyId);
        if (!known || startedAt < known.startedAt) families.set(familyId, { familyId, startedAt });
      }
      if (families.size + 1 <= max) return;
      try {
        const groups: any[] = await (this.prisma.session as any).groupBy({
          by: ['familyId'],
          where: { userId: user.id, familyId: { in: Array.from(families.keys()) } },
          _min: { createdAt: true }
        });
        for (const g of groups || []) {
          const known = g?.familyId ? families.get(g.familyId) : undefined;
          if (known && g._min?.createdAt) known.startedAt = Math.min(known.startedAt, new Date(g._min.createdAt).getTime());
        }
      } catch {
        // Fall back to the live rows' creation times
      }
      const excess = families.size + 1 - max;
      const oldest = Array.from(families.values())
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(0, excess)
        .map((f) => f.familyId);
      const revoked = await this.prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null, OR: [{ familyId: { in: oldest } }, { id: { in: oldest } }] },
        data: { revokedAt: new Date(), isActive: false, revokedReason: REVOKED_SESSION_LIMIT }
      });
      const sessionsRevoked = Number((revoked as any)?.count ?? 0);
      await this.auditAuthEvent('AUTH_SESSION_LIMIT_REVOKED', user as any, ipAddress, userAgent, {
        maxSessions: max,
        revokedFamilies: oldest,
        sessionsRevoked,
        newSessionId
      });
      this.raiseAlert('STAFF_SESSION_LIMIT_REACHED', `${user.email}|${newSessionId}`, {
        email: user.email,
        role: user.role,
        maxSessions: max,
        sessionsSignedOut: oldest.length,
        ipAddress,
        userAgent
      });
    } catch {
      // Best effort: never fails the sign-in
    }
  }

  private sanitizeUser(user: any) {
    const { passwordHash, twoFactor, googleSub, ...sanitized } = user;
    return { ...sanitized, emailVerified: Boolean(user?.emailVerifiedAt) };
  }
}
