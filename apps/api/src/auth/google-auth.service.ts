import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { appendAuditLog } from '../audit/audit-chain';

const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const STAFF_ROLES: readonly Role[] = [Role.SUPER_ADMIN, Role.EVENT_ADMIN, Role.JUDGE, Role.INSPECTOR];

export const STAFF_GOOGLE_REFUSAL =
  'Staff accounts must sign in through the staff console with two-factor authentication.';

export interface VerifiedGoogleIdentity {
  sub: string;
  email: string;
  name: string;
  hostedDomain?: string;
}

/** GOOGLE_CLIENT_ID, trimmed; undefined when Google sign-in is not configured. */
export function getGoogleClientId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = (env.GOOGLE_CLIENT_ID || '').trim();
  return value.length > 0 ? value : undefined;
}

/** Optional comma list of Google Workspace hosted domains (hd claim) allowed to sign in. */
export function getAllowedHostedDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.GOOGLE_ALLOWED_HOSTED_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}

/**
 * "Sign in with Google" via the Google Identity Services ID-token flow.
 * The browser obtains a Google-signed ID token (JWT) and posts it here; we verify signature,
 * audience, issuer and expiry with google-auth-library, then resolve a TEAM_CAPTAIN account.
 * Staff accounts are never reachable through Google: they must use password + 2FA.
 * Configuration is optional: without GOOGLE_CLIENT_ID the feature is simply disabled.
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);
  private client?: OAuth2Client;
  private clientFor?: string;

  constructor(
    private prisma: PrismaService,
    private authService: AuthService
  ) {}

  getPublicConfig(): { enabled: boolean; clientId?: string } {
    const clientId = getGoogleClientId();
    return clientId ? { enabled: true, clientId } : { enabled: false };
  }

  private getClient(clientId: string): OAuth2Client {
    if (!this.client || this.clientFor !== clientId) {
      this.client = new OAuth2Client({ clientId });
      this.clientFor = clientId;
    }
    return this.client;
  }

  /** Verifies a GIS credential and returns the trusted identity, or throws 401/403. */
  async verifyCredential(credential: string): Promise<VerifiedGoogleIdentity> {
    const clientId = getGoogleClientId();
    if (!clientId) {
      throw new NotFoundException('Google sign-in is not enabled');
    }

    let payload: any;
    try {
      const ticket = await this.getClient(clientId).verifyIdToken({ idToken: credential, audience: clientId });
      payload = ticket?.getPayload();
    } catch (err: any) {
      this.logger.warn(`Google ID token rejected: ${err?.message || 'verification failed'}`);
      throw new UnauthorizedException('Google sign-in could not be verified. Please try again.');
    }

    if (!payload || typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedException('Google sign-in could not be verified. Please try again.');
    }
    // Defence in depth: the library checks these too, but the contract must not depend on it.
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(clientId)) {
      throw new UnauthorizedException('Google sign-in could not be verified. Please try again.');
    }
    if (!GOOGLE_ISSUERS.includes(payload.iss)) {
      throw new UnauthorizedException('Google sign-in could not be verified. Please try again.');
    }
    if (typeof payload.email !== 'string' || payload.email.length === 0 || payload.email_verified !== true) {
      throw new UnauthorizedException('Your Google account email address is not verified.');
    }

    const allowedDomains = getAllowedHostedDomains();
    const hd = typeof payload.hd === 'string' ? payload.hd.toLowerCase() : undefined;
    if (allowedDomains.length > 0 && (!hd || !allowedDomains.includes(hd))) {
      throw new ForbiddenException('This Google account is not from an allowed organisation domain.');
    }

    const email = payload.email.trim().toLowerCase();
    const name = typeof payload.name === 'string' && payload.name.trim().length > 0
      ? payload.name.trim().slice(0, 120)
      : email.split('@')[0];

    return { sub: payload.sub, email, name, hostedDomain: hd };
  }

  async loginWithGoogle(credential: string, ipAddress: string = '127.0.0.1', userAgent?: string) {
    const identity = await this.verifyCredential(credential);
    const { email } = identity;

    let user: any = await this.prisma.user.findUnique({ where: { googleSub: identity.sub } });
    let action: 'AUTH_GOOGLE_LOGIN' | 'AUTH_GOOGLE_LINK' | 'AUTH_GOOGLE_REGISTER' = 'AUTH_GOOGLE_LOGIN';

    if (!user) {
      const byEmail: any = await this.prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } }
      });

      if (byEmail) {
        if (STAFF_ROLES.includes(byEmail.role)) {
          await this.refuse(email, ipAddress, userAgent, byEmail, 'Google sign-in refused for staff account');
          throw new ForbiddenException(STAFF_GOOGLE_REFUSAL);
        }
        if (byEmail.role !== Role.TEAM_CAPTAIN) {
          await this.refuse(email, ipAddress, userAgent, byEmail, 'Google sign-in refused for non-captain account');
          throw new ForbiddenException('Google sign-in is only available for team captain accounts.');
        }
        if (!byEmail.isActive) {
          await this.refuse(email, ipAddress, userAgent, byEmail, 'Account deactivated');
          throw new UnauthorizedException('Account has been deactivated. Please contact support.');
        }
        if (byEmail.googleSub && byEmail.googleSub !== identity.sub) {
          await this.refuse(email, ipAddress, userAgent, byEmail, 'Different Google account already linked');
          throw new ForbiddenException('A different Google account is already linked to this email address.');
        }
        if (byEmail.emailVerifiedAt) {
          user = await this.prisma.user.update({
            where: { id: byEmail.id },
            data: { googleSub: identity.sub }
          });
        } else {
          // Pre-account takeover protection: whoever registered this unverified address with a password
          // never proved they own it, while Google just did. Lock that password holder out completely
          // before confirming the address for the Google identity.
          user = await this.linkUnverifiedAccount(byEmail, identity, ipAddress, userAgent);
        }
        action = 'AUTH_GOOGLE_LINK';
      } else {
        // Unusable random password: the account can only sign in with Google (or after a reset).
        const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
        user = await this.prisma.user.create({
          data: {
            email,
            passwordHash,
            fullName: identity.name,
            role: Role.TEAM_CAPTAIN, // Google self-registration is strictly TEAM_CAPTAIN
            organization: '',
            phone: '',
            googleSub: identity.sub,
            authProvider: 'google',
            // Google has verified the address (verifyCredential requires email_verified)
            emailVerifiedAt: new Date(),
            isPasswordTemporary: false,
            mustChangePassword: false,
            isTwoFactorEnabled: false,
            isActive: true
          }
        });
        action = 'AUTH_GOOGLE_REGISTER';
      }
    }

    // Never let Google bypass staff 2FA, even if a staff row somehow carries a googleSub.
    if (STAFF_ROLES.includes(user.role)) {
      await this.refuse(email, ipAddress, userAgent, user, 'Google sign-in refused for staff account');
      throw new ForbiddenException(STAFF_GOOGLE_REFUSAL);
    }
    if (user.role !== Role.TEAM_CAPTAIN) {
      await this.refuse(email, ipAddress, userAgent, user, 'Google sign-in refused for non-captain account');
      throw new ForbiddenException('Google sign-in is only available for team captain accounts.');
    }
    if (!user.isActive) {
      await this.refuse(email, ipAddress, userAgent, user, 'Account deactivated');
      throw new UnauthorizedException('Account has been deactivated. Please contact support.');
    }

    const result = await this.authService.issueSessionForUser(user, ipAddress, userAgent);
    await this.authService.recordLoginAttempt(user.email, true, undefined, ipAddress);
    await this.audit(action, user, ipAddress, userAgent, { provider: 'google' });
    return result;
  }

  /**
   * Links a Google identity to an existing password account whose email address was never verified.
   * Atomically: the password is replaced with an unusable random bcrypt hash, every session of the
   * account is revoked, outstanding verification / password-reset tokens are invalidated and the
   * address is marked verified. The event is audited as AUTH_GOOGLE_TAKEOVER_PROTECTION.
   */
  private async linkUnverifiedAccount(
    existing: any,
    identity: VerifiedGoogleIdentity,
    ipAddress: string,
    userAgent: string | undefined
  ) {
    const unusableHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.user.update({
        where: { id: existing.id },
        data: { googleSub: identity.sub, passwordHash: unusableHash, emailVerifiedAt: now }
      });
      const sessions = await tx.session.updateMany({
        where: { userId: existing.id, revokedAt: null },
        data: { revokedAt: now, isActive: false }
      });
      const tokens = await tx.authToken.updateMany({
        where: { userId: existing.id, usedAt: null },
        data: { usedAt: now, codeCipher: null }
      });
      return {
        updated,
        sessionsRevoked: Number(sessions?.count ?? 0),
        tokensInvalidated: Number(tokens?.count ?? 0)
      };
    });
    await this.audit('AUTH_GOOGLE_TAKEOVER_PROTECTION', result.updated, ipAddress, userAgent, {
      provider: 'google',
      passwordReplaced: true,
      sessionsRevoked: result.sessionsRevoked,
      tokensInvalidated: result.tokensInvalidated,
      emailVerified: true
    });
    return result.updated;
  }

  private async refuse(email: string, ipAddress: string, userAgent: string | undefined, user: any, reason: string) {
    await this.authService.recordLoginAttempt(email, false, reason, ipAddress);
    await this.audit('AUTH_GOOGLE_REFUSED', user, ipAddress, userAgent, { provider: 'google', reason });
  }

  private async audit(action: string, user: any, ipAddress: string, userAgent: string | undefined, afterState: any) {
    try {
      await appendAuditLog(this.prisma, {
        actorId: user?.id,
        actorEmail: user?.email,
        actorRole: user?.role,
        action,
        entityType: 'User',
        entityId: user?.id,
        afterState,
        ipAddress: ipAddress || '127.0.0.1',
        userAgent: userAgent || 'Unknown'
      });
    } catch {
      // Non-fatal, like login attempt recording
    }
  }
}
