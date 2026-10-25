import * as crypto from 'crypto';

const MIN_SECRET_LENGTH = 32;

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Secret used to sign public (team captain) access tokens.
 */
export function getPublicJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error('FATAL: JWT_SECRET environment variable is missing or insecure (< 32 chars)');
  }
  return secret;
}

/**
 * Secret used to sign administrative (staff) access tokens.
 *
 * Production: JWT_ADMIN_SECRET is mandatory (>= 32 chars) and must differ from JWT_SECRET.
 * Development/test: falls back to a value derived from JWT_SECRET so local setups keep working.
 *
 * Single source of truth: every signer/verifier of admin tokens (AuthService, JwtStrategy,
 * scoring gateway) must call this helper so the derivation can never drift.
 */
export function getAdminJwtSecret(): string {
  const publicSecret = getPublicJwtSecret();
  const adminSecret = process.env.JWT_ADMIN_SECRET;

  if (isProduction()) {
    if (!adminSecret || adminSecret.length < MIN_SECRET_LENGTH) {
      throw new Error('FATAL: JWT_ADMIN_SECRET must be configured with at least 32 characters in production');
    }
    if (adminSecret === publicSecret) {
      throw new Error('FATAL: JWT_ADMIN_SECRET must differ from JWT_SECRET in production');
    }
    return adminSecret;
  }

  return adminSecret || publicSecret + '_admin_secret_key_override_32';
}

/** Words that betray a template / sample value rather than a generated secret. */
export const SECRET_PLACEHOLDER_PATTERN =
  /REPLACE|placeholder|change[_-]?me|example|your[_-]?(secret|key)|dummy|insecure|super_secret|default|xxxxxxxx/i;

/**
 * Key secrets validated in production. `presence` = this check reports a missing value / short value
 * (false where another startup check already reports it: JWT_SECRET in main.ts, VERIFICATION_CODE_KEY
 * in verification-code.util.ts). The placeholder check always applies.
 */
const PRODUCTION_SECRETS: ReadonlyArray<{ name: string; presence: boolean }> = [
  { name: 'JWT_SECRET', presence: false },
  { name: 'JWT_ADMIN_SECRET', presence: true },
  { name: 'TWO_FACTOR_ENCRYPTION_KEY', presence: true },
  { name: 'COOKIE_SECRET', presence: true },
  { name: 'VERIFICATION_CODE_KEY', presence: false }
];

/**
 * Startup check (main.ts): in production JWT_ADMIN_SECRET, TWO_FACTOR_ENCRYPTION_KEY and COOKIE_SECRET
 * are mandatory (at least 32 characters), JWT_ADMIN_SECRET differs from JWT_SECRET, and none of the key
 * secrets may contain placeholder text (REPLACE_..., changeme, example, ...). Outside production nothing
 * is checked, so local setups start without these secrets. Never echoes a secret value.
 */
export function productionSecretConfigErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const errors: string[] = [];
  for (const { name, presence } of PRODUCTION_SECRETS) {
    const value = (env[name] || '').trim();
    if (!value) {
      if (presence) errors.push(`${name} is required in production.`);
      continue;
    }
    if (presence && value.length < MIN_SECRET_LENGTH) {
      errors.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters in production.`);
    } else if (SECRET_PLACEHOLDER_PATTERN.test(value)) {
      errors.push(`${name} contains placeholder text in production.`);
    }
  }
  const jwt = (env.JWT_SECRET || '').trim();
  if (jwt && jwt === (env.JWT_ADMIN_SECRET || '').trim()) {
    errors.push('JWT_ADMIN_SECRET must differ from JWT_SECRET in production.');
  }
  return errors;
}

/**
 * Secret that signs accreditation-pass QR payloads.
 * Production: PASS_SIGNING_SECRET is mandatory (enforced at startup by productionDataProtectionConfigErrors);
 * it never falls back to JWT_SECRET, so a leaked session key cannot forge passes and vice versa.
 * Development/test: falls back to an HMAC subkey of JWT_SECRET so local setups keep working.
 */
export function getPassSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  const dedicated = (env.PASS_SIGNING_SECRET || '').trim();
  if (env.NODE_ENV === 'production') {
    if (!dedicated || dedicated.length < MIN_SECRET_LENGTH) {
      throw new Error('PASS_SIGNING_SECRET must be configured with at least 32 characters in production');
    }
    return dedicated;
  }
  if (dedicated) return dedicated;
  const jwt = env.JWT_SECRET;
  if (!jwt) throw new Error('PASS_SIGNING_SECRET (or JWT_SECRET outside production) is not configured');
  return crypto.createHmac('sha256', jwt).update('gcdis-pass-signing-dev-v1').digest('hex');
}

/** Errors for a site URL that must be an absolute https:// origin in production (never echoes secrets). */
export function httpsSiteUrlErrors(name: string, raw: string | undefined, required: boolean): string[] {
  const value = (raw || '').trim();
  if (!value) return required ? [`${name} is required in production.`] : [];
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('protocol');
    if (url.username || url.password || url.search || url.hash) throw new Error('extra');
  } catch {
    return [`${name} must be an absolute https:// URL in production (for example https://www.gcdis.in).`];
  }
  return [];
}

/**
 * Startup check (main.ts), production only:
 * - PASS_SIGNING_SECRET is set, at least 32 characters, not placeholder text and different from JWT_SECRET
 * - ADMIN_SITE_URL, when set, is an absolute https:// URL (PUBLIC_SITE_URL is checked by
 *   emailLinkConfigErrors in account-recovery.service.ts, which also requires it)
 * JWT_REFRESH_SECRET is intentionally not checked: no code reads it (refresh tokens are opaque,
 * hashed database records), so it is optional.
 */
export function productionDataProtectionConfigErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const errors: string[] = [];

  const pass = (env.PASS_SIGNING_SECRET || '').trim();
  if (!pass) {
    errors.push('PASS_SIGNING_SECRET is required in production.');
  } else if (pass.length < MIN_SECRET_LENGTH) {
    errors.push(`PASS_SIGNING_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production.`);
  } else if (SECRET_PLACEHOLDER_PATTERN.test(pass)) {
    errors.push('PASS_SIGNING_SECRET contains placeholder text in production.');
  } else if (pass === (env.JWT_SECRET || '').trim()) {
    errors.push('PASS_SIGNING_SECRET must differ from JWT_SECRET in production.');
  }

  // Signs the 5-minute download links for private uploads: a dedicated key, never the session key.
  const upload = (env.UPLOAD_SIGNING_SECRET || '').trim();
  if (!upload) {
    errors.push('UPLOAD_SIGNING_SECRET is required in production.');
  } else if (upload.length < MIN_SECRET_LENGTH) {
    errors.push(`UPLOAD_SIGNING_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production.`);
  } else if (SECRET_PLACEHOLDER_PATTERN.test(upload)) {
    errors.push('UPLOAD_SIGNING_SECRET contains placeholder text in production.');
  } else if (upload === (env.JWT_SECRET || '').trim()) {
    errors.push('UPLOAD_SIGNING_SECRET must differ from JWT_SECRET in production.');
  }

  errors.push(...httpsSiteUrlErrors('ADMIN_SITE_URL', env.ADMIN_SITE_URL, false));
  return errors;
}

/**
 * Key for 2FA challenge tokens: derived from JWT_SECRET via HMAC so a challenge token can never
 * verify as an access token (and vice versa).
 */
export function getChallengeJwtSecret(): string {
  return crypto.createHmac('sha256', getPublicJwtSecret()).update('gcdis-2fa-challenge-v1').digest('hex');
}
