import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  UseGuards,
  Request,
  Response,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  Headers,
  Ip,
  Query,
  Delete,
  Param,
  ParseUUIDPipe,
  Optional
} from '@nestjs/common';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { GoogleAuthService } from './google-auth.service';
import { LoginSchema, RegisterUserSchema, UserRole } from '@gcdis/shared';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';
import { Role } from '@prisma/client';
import { AccountIpRateLimiterGuard, RateLimit } from '../common/guards/rate-limiter.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { Public } from '../common/decorators/public.decorator';
import { parseBody } from '../common/utils/validate-body.util';
import { PaginationQueryDto, toPrismaPagination } from '../common/dto/pagination-query.dto';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import {
  accessTokenFromCookies,
  allSessionCookieNames,
  clearCookieOptions,
  cookiesToClear,
  refreshTokenFromCookies,
  sessionAppFor,
  sessionCookieConfig
} from './session-cookies.util';
import { OptionalSessionGuard } from './optional-session.guard';
import { adminSessionMaxMs, hasRecentStepUp, StepUpGuard } from './step-up.guard';
import { AccountRecoveryService } from './account-recovery.service';
import { adminIdleTimeoutMinutes } from './staff-session-policy';

/**
 * Clear-Site-Data sent when the staff console signs out (ADMIN_LOGOUT_CLEAR_SITE_DATA, default
 * '"cache", "storage"'; "off" disables it). The console's own session cookies are already cleared by the
 * logout response itself; "cookies" is not in the default because it applies to the whole registrable
 * domain of the API host and would also end a portal session held in the same browser.
 */
export function adminLogoutClearSiteData(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.ADMIN_LOGOUT_CLEAR_SITE_DATA ?? '').trim();
  if (!raw) return '"cache", "storage"';
  if (/^(off|false|none|0)$/i.test(raw)) return null;
  const allowed = new Set(['"cache"', '"cookies"', '"storage"', '"executionContexts"', '"*"']);
  const parts = raw.split(',').map((p) => p.trim()).filter((p) => allowed.has(p));
  return parts.length > 0 ? parts.join(', ') : '"cache", "storage"';
}

/** Query for GET /auth/users: pagination plus an optional staff-only filter and metadata envelope. */
export class UsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['all', 'staff', 'captains'])
  scope?: 'all' | 'staff' | 'captains';

  /** Case-insensitive match on the email address or the name. */
  @IsOptional()
  @IsString()
  @MaxLength(254)
  search?: string;

  /** Email verification status filter: true (verified) or false (not verified). */
  @IsOptional()
  @Transform(({ value }) => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : value))
  @IsIn([true, false])
  verified?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  withMeta?: boolean;
}

const STAFF_ROLES = [Role.SUPER_ADMIN, Role.EVENT_ADMIN, Role.JUDGE, Role.INSPECTOR] as const;

const CreateStaffUserSchema = z.object({
  email: z.string().trim().email('Invalid email address').max(254),
  fullName: z.string().trim().min(2, 'Full name is required').max(120),
  role: z.enum(STAFF_ROLES),
  organization: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(32).optional(),
  // Staff passwords: at least 14 characters (STAFF_PASSWORD_MIN_LENGTH); the policy answers WEAK_PASSWORD
  tempPassword: z.string().min(1).max(128).optional()
});

const ChangeUserRoleSchema = z
  .object({
    // Validated against the staff roles by the service, which answers formal boundary messages
    role: z.string({ message: 'role is required' }).trim().min(1, 'role is required').max(32)
  })
  .strict();

const SetUserStatusSchema = z
  .object({
    isActive: z.boolean({ message: 'isActive must be true or false' }),
    reason: z.string().trim().max(300, 'reason must be at most 300 characters').optional()
  })
  .strict();

const VerifyEmailCodeSchema = z.object({
  code: z
    .string({ message: 'code is required' })
    .trim()
    .regex(/^\d{6}$/, 'Please enter the six-digit code from the verification email.')
});

const MarkEmailVerifiedSchema = z
  .object({
    reason: z.string().trim().max(300, 'reason must be at most 300 characters').optional()
  })
  .strict();

const Verify2faLoginSchema = z.object({
  challengeToken: z.string().min(1, 'challengeToken is required').max(4096),
  code: z.string().trim().min(1, 'code is required').max(32)
});

const Generate2faSchema = z.object({
  challengeToken: z.string().min(1, 'challengeToken is required').max(4096)
});

const GoogleCredentialSchema = z.object({
  // GIS ID tokens are compact JWTs (~1-2 KB); cap generously to bound verification work.
  credential: z.string().trim().min(1, 'credential is required').max(8192)
});

const StepUpSchema = z.object({
  // 6-digit TOTP code or a recovery code (XXXX-XXXX)
  code: z.string().trim().min(1, 'code is required').max(32)
});

const ForgotPasswordSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address.').max(254)
});

const ResetPasswordSchema = z.object({
  token: z.string().trim().min(1, 'token is required').max(256),
  // The policy enforces the 128-character maximum with a formal WEAK_PASSWORD message
  newPassword: z.string().min(1, 'newPassword is required').max(1024)
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'currentPassword is required').max(256),
  newPassword: z.string().min(1, 'newPassword is required').max(256)
});

/** Missing/blank challenge token -> 401 (unauthenticated), other malformed fields -> 400. */
function requireChallengeToken(body: any): void {
  const token = body?.challengeToken;
  if (typeof token !== 'string' || token.length === 0) {
    throw new UnauthorizedException('Missing 2FA challenge token');
  }
}

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private googleAuthService: GoogleAuthService,
    @Optional() private accountRecovery?: AccountRecoveryService
  ) {}

  /** Public: lets the portal hide the Google button when GOOGLE_CLIENT_ID is not configured. */
  @Public()
  @Get('google/config')
  getGoogleConfig() {
    return this.googleAuthService.getPublicConfig();
  }

  /**
   * Sign in with Google (GIS ID-token flow). Team captains only: creates or links a captain
   * account; staff accounts are refused so Google can never bypass staff 2FA.
   */
  @Public()
  @UseGuards(AccountIpRateLimiterGuard, CsrfGuard)
  @RateLimit({ points: 10, duration: 900, isStrictAuth: true })
  @HttpCode(HttpStatus.OK)
  @Post('google')
  async googleLogin(
    @Body() body: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Response({ passthrough: true }) res: any
  ) {
    const input = parseBody(GoogleCredentialSchema, body) as { credential: string };
    const result = await this.googleAuthService.loginWithGoogle(input.credential, ip, userAgent);
    this.setAuthCookies(res, result.accessToken, result.refreshToken, result.audience === 'gcdis-admin');

    return {
      user: result.user,
      mustChangePassword: result.mustChangePassword,
      message: 'Login successful'
    };
  }

  @Public()
  @UseGuards(AccountIpRateLimiterGuard, CsrfGuard)
  @RateLimit({
    points: 500,
    duration: 60,
    isStrictAuth: false,
    accountFromBody: 'email',
    // Account creation per network: 10 per hour per IP
    ipPoints: 10,
    ipDuration: 3600
  })
  @Post('register')
  async register(
    @Body() body: unknown,
    @Ip() ip: string,
    @Response({ passthrough: true }) res: any
  ) {
    const input = parseBody(RegisterUserSchema, body);
    const result = await this.authService.register(input, ip);
    this.setAuthCookies(res, result.accessToken, result.refreshToken, false);
    // Verification email: never fails the registration, but the portal is told whether it actually went out
    // so it does not claim a code was sent when delivery failed (it then offers "Resend code").
    let verificationEmailSent = false;
    if (this.accountRecovery) {
      verificationEmailSent = await this.accountRecovery.sendVerificationEmail(result.user as any).catch(() => false);
    }
    return {
      user: result.user,
      message: 'Registration successful',
      verificationEmailSent
    };
  }

  /** Provisions a staff account (Super Administrator, step-up required). Audited; a new Super Administrator raises an alert. */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Post('staff-user')
  async createStaffUser(
    @Request() req: any,
    @Body() body: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string
  ) {
    // Fields are guaranteed present by the schema (api tsconfig is non-strict, so cast the inferred type)
    const input = parseBody(CreateStaffUserSchema, body) as {
      email: string;
      fullName: string;
      role: Role;
      organization?: string;
      phone?: string;
      tempPassword?: string;
    };
    return this.authService.createStaffUser(req.user.id, input, ip, userAgent);
  }

  @Public()
  @UseGuards(AccountIpRateLimiterGuard, CsrfGuard)
  @RateLimit({ points: 10, duration: 900, isStrictAuth: true, accountFromBody: 'email' })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() body: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Response({ passthrough: true }) res: any
  ) {
    const input = parseBody(LoginSchema, body);
    const result = await this.authService.login(input, ip, userAgent);

    if ('requires2fa' in result && result.requires2fa) {
      return result;
    }

    const authResult = result as {
      accessToken: string;
      refreshToken: string;
      user: any;
      mustChangePassword: boolean;
      audience: string;
    };

    if (authResult.accessToken && authResult.refreshToken) {
      const isAdmin = authResult.audience === 'gcdis-admin';
      this.setAuthCookies(res, authResult.accessToken, authResult.refreshToken, isAdmin);
    }

    return {
      user: authResult.user,
      mustChangePassword: authResult.mustChangePassword,
      message: 'Login successful'
    };
  }

  @Public()
  @UseGuards(AccountIpRateLimiterGuard, CsrfGuard)
  @RateLimit({ points: 5, duration: 300, isStrictAuth: true })
  @HttpCode(HttpStatus.OK)
  @Post('2fa/verify-login')
  async verify2faLogin(
    @Body() rawBody: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Response({ passthrough: true }) res: any
  ) {
    requireChallengeToken(rawBody);
    const body = parseBody(Verify2faLoginSchema, rawBody);
    const result = await this.authService.verify2faLogin(body.challengeToken, body.code, ip, userAgent);
    const isAdmin = result.audience === 'gcdis-admin';
    this.setAuthCookies(res, result.accessToken, result.refreshToken, isAdmin);

    return {
      user: result.user,
      mustChangePassword: result.mustChangePassword,
      message: '2FA verification successful'
    };
  }

  @Public()
  @UseGuards(AccountIpRateLimiterGuard, CsrfGuard)
  @RateLimit({ points: 5, duration: 300, isStrictAuth: true })
  @HttpCode(HttpStatus.OK)
  @Post('2fa/generate')
  async generate2faSecret(@Body() rawBody: unknown) {
    requireChallengeToken(rawBody);
    const body = parseBody(Generate2faSchema, rawBody);
    return this.authService.generate2faSecret(body.challengeToken);
  }

  @Public()
  @UseGuards(AccountIpRateLimiterGuard, CsrfGuard)
  @RateLimit({ points: 5, duration: 300, isStrictAuth: true })
  @HttpCode(HttpStatus.OK)
  @Post('2fa/enable')
  async enable2fa(
    @Body() rawBody: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Response({ passthrough: true }) res: any
  ) {
    requireChallengeToken(rawBody);
    const body = parseBody(Verify2faLoginSchema, rawBody);
    const result = await this.authService.enable2fa(body.challengeToken, body.code, ip, userAgent);

    if (result.accessToken && result.refreshToken) {
      const isAdmin = result.audience === 'gcdis-admin';
      this.setAuthCookies(res, result.accessToken, result.refreshToken, isAdmin);
    }

    return result;
  }

  /** Legacy: confirms an email address with a single-use link token issued before codes replaced links. */
  @Public()
  @UseGuards(AccountIpRateLimiterGuard, CsrfGuard)
  @RateLimit({ points: 10, duration: 900, isStrictAuth: true })
  @HttpCode(HttpStatus.OK)
  @Post('verify-email')
  async verifyEmail(
    @Body() body: any,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string
  ) {
    return this.requireRecovery().verifyEmail(body?.token, ip, userAgent);
  }

  /**
   * Public: { deliveryConfigured }. Outside production it is false while SMTP is not configured, so the
   * portal can say that verification emails are not delivered; production always answers true.
   */
  @Public()
  @Get('email-delivery')
  getEmailDelivery() {
    return this.requireRecovery().emailDeliveryInfo();
  }

  /**
   * Confirms the signed-in captain's email address with the emailed 6-digit code. 10 attempts per
   * 15 minutes per account and IP (30 per IP); the code itself is burned after 5 wrong attempts.
   */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.TEAM_CAPTAIN)
  @RateLimit({
    points: 10,
    duration: 900,
    isStrictAuth: true,
    ipPoints: 30,
    message: 'Too many verification attempts. Please wait {wait} before trying again.'
  })
  @HttpCode(HttpStatus.OK)
  @Post('verify-email-code')
  async verifyEmailCode(
    @Request() req: any,
    @Body() body: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string
  ) {
    const input = parseBody(VerifyEmailCodeSchema, body) as { code: string };
    return this.requireRecovery().verifyEmailCode(req.user.id, input.code, ip, userAgent);
  }

  /** The signed-in captain's verification state: pending code expiry and resend cooldown (never the code). */
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.TEAM_CAPTAIN)
  @Get('verification-status')
  async verificationStatus(@Request() req: any) {
    return this.requireRecovery().verificationStatus(req.user.id);
  }

  /** Sends a new verification code to the signed-in captain (60 s cooldown; 5 per hour per account, 20 per IP). */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.TEAM_CAPTAIN)
  @RateLimit({
    points: 5,
    duration: 3600,
    isStrictAuth: true,
    ipPoints: 20,
    message: 'A verification code was sent recently. Please wait {wait} before requesting another.'
  })
  @HttpCode(HttpStatus.OK)
  @Post('resend-verification')
  async resendVerification(
    @Request() req: any,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string
  ) {
    return this.requireRecovery().resendVerification(req.user.id, ip, userAgent);
  }

  /**
   * Starts a password reset. Always 200 { success: true } (no account enumeration); only active team
   * captain accounts receive an email. Max 3 per hour per email and per IP.
   */
  @Public()
  @UseGuards(AccountIpRateLimiterGuard, CsrfGuard)
  @RateLimit({ points: 3, duration: 3600, isStrictAuth: true, ipPoints: 3, accountFromBody: 'email' })
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  async forgotPassword(
    @Body() body: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string
  ) {
    const input = parseBody(ForgotPasswordSchema, body) as { email: string };
    return this.requireRecovery().forgotPassword(input.email, ip, userAgent);
  }

  /** Completes a password reset with the emailed token; revokes every session of the account. */
  @Public()
  @UseGuards(AccountIpRateLimiterGuard, CsrfGuard)
  @RateLimit({ points: 10, duration: 900, isStrictAuth: true })
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  async resetPassword(
    @Body() body: any,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string
  ) {
    if (typeof body?.token !== 'string' || body.token.trim().length === 0) {
      // Missing token: same answer as an unknown one
      return this.requireRecovery().resetPassword(undefined, undefined, ip, userAgent);
    }
    const input = parseBody(ResetPasswordSchema, body) as { token: string; newPassword: string };
    return this.requireRecovery().resetPassword(input.token, input.newPassword, ip, userAgent);
  }

  private requireRecovery(): AccountRecoveryService {
    if (!this.accountRecovery) throw new Error('AccountRecoveryService is not available');
    return this.accountRecovery;
  }

  @UseGuards(AuthGuard('jwt'), CsrfGuard, AccountIpRateLimiterGuard)
  @RateLimit({
    points: 5,
    duration: 900,
    isStrictAuth: true,
    message: 'Too many password change attempts. Please wait {wait} before trying again.'
  })
  @Post('change-password')
  async changePassword(
    @Request() req: any,
    @Body() rawBody: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string
  ) {
    const body = parseBody(ChangePasswordSchema, rawBody);
    return this.authService.changePassword(req.user.id, body.currentPassword, body.newPassword, ip, userAgent);
  }

  @Public()
  @UseGuards(AccountIpRateLimiterGuard, CsrfGuard)
  @RateLimit({ points: 15, duration: 60, isStrictAuth: true })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Request() req: any,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Response({ passthrough: true }) res: any
  ) {
    const refreshToken = refreshTokenFromCookies(req) || req.body?.refreshToken;

    const tokens = await this.authService.rotateSession(refreshToken, ip, userAgent);
    const isAdmin = tokens.audience === 'gcdis-admin';
    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken, isAdmin);

    return {
      success: true,
      message: 'Session refreshed'
    };
  }

  /**
   * Signs out of the calling app. Works with the refresh cookie alone (an expired access token must
   * not prevent sign-out), so it is public, but still CSRF-origin checked. Revokes the session named
   * by the refresh cookie, plus the session of a correctly signed access token when one is sent.
   */
  @Public()
  @UseGuards(AccountIpRateLimiterGuard, CsrfGuard)
  @RateLimit({ points: 15, duration: 60, isStrictAuth: true })
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(
    @Request() req: any,
    @Response({ passthrough: true }) res: any
  ) {
    const refreshToken = refreshTokenFromCookies(req) || req.body?.refreshToken;
    const bearer = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '') || null;
    const sessionId = req.user?.sid || this.authService.sessionIdFromAccessToken(bearer || accessTokenFromCookies(req));

    await this.authService.logout(refreshToken, sessionId || undefined);
    // Sign out of the calling app only; a session in the other app stays valid
    this.clearAuthCookies(res, cookiesToClear(req));
    // Staff console: ask the browser to drop cached responses, cookies and storage as well
    if (sessionAppFor(req) === 'admin') {
      const clearSiteData = adminLogoutClearSiteData();
      if (clearSiteData && res?.setHeader) res.setHeader('Clear-Site-Data', clearSiteData);
    }
    return { success: true, message: 'Logged out successfully' };
  }

  @UseGuards(AuthGuard('jwt'), CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout-all')
  async logoutAll(
    @Request() req: any,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Response({ passthrough: true }) res: any
  ) {
    await this.authService.logoutAll(req.user.id, {
      email: req.user.email,
      role: req.user.role,
      ipAddress: ip,
      userAgent
    });
    this.clearAuthCookies(res);
    return { success: true, message: 'All active sessions revoked' };
  }

  /**
   * Step-up re-authentication: a current authenticator code or an unused recovery code opens a
   * 10-minute window on this session for sensitive actions. Answers { stepUpUntil }.
   */
  @UseGuards(AuthGuard('jwt'), CsrfGuard, AccountIpRateLimiterGuard)
  @RateLimit({ points: 10, duration: 300, isStrictAuth: true })
  @HttpCode(HttpStatus.OK)
  @Post('step-up')
  async stepUp(
    @Request() req: any,
    @Body() rawBody: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string
  ) {
    const body = parseBody(StepUpSchema, rawBody) as { code: string };
    return this.authService.stepUp(req.user, body.code, ip, userAgent);
  }

  /** The caller's own active sessions. */
  @UseGuards(AuthGuard('jwt'))
  @Get('sessions')
  async listSessions(@Request() req: any) {
    return this.authService.listSessions(req.user.id, req.user.sid);
  }

  /**
   * Revokes one of the caller's own sessions. Step-up is required unless it is the current session
   * (revoking the current session signs this app out and clears its cookies).
   */
  @UseGuards(AuthGuard('jwt'), CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @Delete('sessions/:id')
  async revokeSession(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
    @Response({ passthrough: true }) res: any
  ) {
    const result = await this.authService.revokeSession(req.user, id, hasRecentStepUp(req.user), ip, userAgent);
    if (result.current) {
      this.clearAuthCookies(res, cookiesToClear(req));
    }
    return result;
  }

  // Session probe: 200 { user: null } for a visitor without any session (see OptionalSessionGuard)
  @Public()
  @UseGuards(OptionalSessionGuard)
  @Get('me')
  async getProfile(@Request() req: any) {
    if (!req.user) return { user: null };
    const user = await this.authService.findById(req.user.id);
    // Staff sessions: the server-enforced idle timeout, so the console can warn before it expires
    if (req.user.aud === 'gcdis-admin') {
      return { user, session: { idleTimeoutMinutes: adminIdleTimeoutMinutes() } };
    }
    return { user };
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Get('users')
  async getAllUsers(@Query() query: UsersQueryDto) {
    const page = toPrismaPagination(query, 100);
    const scope = query.scope ?? 'all';
    if (query.withMeta) {
      const { items, total } = await this.authService.findUsersWithTotal(page, scope, query.search, { verified: query.verified });
      return {
        items,
        total,
        page: Math.floor(page.skip / page.take) + 1,
        limit: page.take
      };
    }
    // Default response shape is unchanged: a bare array of users
    return this.authService.findAllUsers(page, scope, query.search, { verified: query.verified });
  }

  /**
   * Changes a staff member's role (Super Administrator, administrative session, step-up required).
   * Answers the updated user in the same shape as GET /auth/users items.
   */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Patch('users/:id/role')
  async changeUserRole(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() rawBody: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string
  ) {
    const body = parseBody(ChangeUserRoleSchema, rawBody) as { role: string };
    return this.authService.changeUserRole(req.user, id, body.role, ip, userAgent);
  }

  /**
   * Deactivates or reactivates an account (Super Administrator, administrative session, step-up
   * required). Deactivation revokes every session of the account immediately.
   */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Patch('users/:id/status')
  async setUserStatus(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() rawBody: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string
  ) {
    const body = parseBody(SetUserStatusSchema, rawBody) as { isActive: boolean; reason?: string };
    return this.authService.setUserActiveStatus(req.user, id, body.isActive, body.reason, ip, userAgent);
  }

  /**
   * Active team captains whose email address is not verified, with their teams and registration counts
   * (Super Administrator and Event Administrator; shown on the Registrations tab). Paged: { items, total }.
   */
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('captains/awaiting-verification')
  async getCaptainsAwaitingVerification(@Query() query: UsersQueryDto) {
    const page = toPrismaPagination(query, 100);
    const { items, total } = await this.requireRecovery().listPendingVerifications(page, query.search);
    return { items, total, page: Math.floor(page.skip / page.take) + 1, limit: page.take };
  }

  /**
   * Sends a new verification code to an unverified team captain (Super and Event Administrators,
   * administrative session). 10 per hour per staff member; the captain's own limits apply too. Audited.
   */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @RateLimit({
    points: 10,
    duration: 3600,
    isStrictAuth: false,
    message: 'Several verification emails have been sent recently. Please wait {wait} before sending another.'
  })
  @HttpCode(HttpStatus.OK)
  @Post('users/:id/resend-verification')
  async adminResendVerification(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string
  ) {
    return this.requireRecovery().adminResendVerification(req.user, id, ip, userAgent);
  }

  /**
   * Marks a team captain's email address as verified without the emailed code (Super and Event
   * Administrators, administrative session, step-up required). Not available for staff accounts. Audited.
   */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('users/:id/mark-email-verified')
  async adminMarkEmailVerified(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() rawBody: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string
  ) {
    const body = parseBody(MarkEmailVerifiedSchema, rawBody ?? {}) as { reason?: string };
    return this.requireRecovery().adminMarkEmailVerified(req.user, id, body.reason, ip, userAgent);
  }

  /**
   * Reveals a team captain's pending verification code so staff can pass it on by telephone while email
   * delivery is unavailable (Super and Event Administrators, step-up required, 30 per hour). Every reveal
   * is audited with the staff member and the target account; the code is never written to the log.
   */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @RateLimit({ points: 30, duration: 3600, isStrictAuth: false, message: 'Too many codes have been revealed. Please wait {wait}.' })
  @HttpCode(HttpStatus.OK)
  @Post('users/:id/reveal-verification-code')
  async adminRevealVerificationCode(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string
  ) {
    return this.requireRecovery().adminRevealVerificationCode(req.user, id, ip, userAgent);
  }

  private setAuthCookies(res: any, accessToken: string, refreshToken: string, isAdmin: boolean) {
    // Names and options per environment: __Host-/__Secure- prefixed, Secure, refresh at Path=/api/auth in
    // production; legacy names over plain http in development (see session-cookies.util.ts)
    const { names, access, refresh } = sessionCookieConfig();

    if (res && res.cookie) {
      if (isAdmin) {
        res.cookie(names.adminAccess, accessToken, {
          ...access,
          maxAge: 10 * 60 * 1000 // 10 mins
        });
        res.cookie(names.adminRefresh, refreshToken, {
          ...refresh,
          maxAge: adminSessionMaxMs() // absolute staff session lifetime (ADMIN_SESSION_MAX_HOURS, default 12h)
        });
      } else {
        res.cookie(names.publicAccess, accessToken, {
          ...access,
          maxAge: 10 * 60 * 1000 // 10 mins
        });
        res.cookie(names.publicRefresh, refreshToken, {
          ...refresh,
          maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });
      }
    }
  }

  /** Clears the given session cookies (default: every current and legacy name) with matching path/Secure. */
  private clearAuthCookies(res: any, names: string[] = allSessionCookieNames()) {
    if (res && res.clearCookie) {
      for (const name of names) res.clearCookie(name, clearCookieOptions(name));
    }
  }
}
