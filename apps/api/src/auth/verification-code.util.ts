import * as crypto from 'crypto';

/**
 * Email verification codes (6 digits).
 * - Generated with a CSPRNG (crypto.randomInt).
 * - Stored as a salted HMAC-SHA256 (keyed with a server secret) for checking, and AES-256-GCM encrypted
 *   so that authorised staff can reveal a pending code (step-up, audited). Never stored in plaintext.
 * Key: VERIFICATION_CODE_KEY (required in production; at least 32 characters, or 32 bytes as hex/base64).
 * Outside production it falls back to a key derived from JWT_SECRET (or a fixed development value).
 */

export const EMAIL_CODE_LENGTH = 6;
export const EMAIL_CODE_PATTERN = /^\d{6}$/;
/** Stored code hashes start with this prefix (link tokens are plain SHA-256 hex). */
export const CODE_HASH_PREFIX = 'code1$';
const CIPHER_PREFIX = 'v1.';
const DEV_FALLBACK = 'gcdis-development-only-verification-code-key';

/** A uniformly random 6-digit code ("000000" to "999999"). */
export function generateVerificationCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(EMAIL_CODE_LENGTH, '0');
}

/** Startup check: production requires an explicit, strong VERIFICATION_CODE_KEY. */
export function verificationCodeConfigErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const raw = (env.VERIFICATION_CODE_KEY || '').trim();
  if (!raw) return ['VERIFICATION_CODE_KEY is required in production (encryption of email verification codes).'];
  if (rootKeyMaterial(raw).length < 32) {
    return ['VERIFICATION_CODE_KEY must be at least 32 characters (or 32 bytes as hex / base64).'];
  }
  return [];
}

function rootKeyMaterial(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64,}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (/^[A-Za-z0-9+/]{43,}={0,2}$/.test(raw) && Buffer.from(raw, 'base64').length >= 32) return Buffer.from(raw, 'base64');
  return Buffer.from(raw, 'utf8');
}

/** Root secret: VERIFICATION_CODE_KEY, or (development only) derived from JWT_SECRET. */
function rootKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const configured = (env.VERIFICATION_CODE_KEY || '').trim();
  if (configured) return rootKeyMaterial(configured);
  if (env.NODE_ENV === 'production') throw new Error('VERIFICATION_CODE_KEY is not configured.');
  return Buffer.from(`${DEV_FALLBACK}:${env.JWT_SECRET || ''}`, 'utf8');
}

/** Separate sub-keys for hashing and for encryption. */
function subKey(purpose: 'hmac' | 'enc', env?: NodeJS.ProcessEnv): Buffer {
  return crypto.createHmac('sha256', rootKey(env)).update(`gcdis-email-code:${purpose}`).digest();
}

function mac(userId: string, salt: string, code: string, env?: NodeJS.ProcessEnv): Buffer {
  return crypto.createHmac('sha256', subKey('hmac', env)).update(`${salt}:${userId}:${code}`).digest();
}

/** Salted HMAC of the code, bound to the user; unique per issued code (random salt). */
export function hashVerificationCode(userId: string, code: string, env?: NodeJS.ProcessEnv): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${CODE_HASH_PREFIX}${salt}$${mac(userId, salt, code, env).toString('hex')}`;
}

/** Constant-time check of a submitted code against a stored hash. */
export function verifyCodeHash(userId: string, code: string, stored: string, env?: NodeJS.ProcessEnv): boolean {
  if (typeof stored !== 'string' || !stored.startsWith(CODE_HASH_PREFIX)) return false;
  const [salt, hex] = stored.slice(CODE_HASH_PREFIX.length).split('$');
  if (!salt || !hex || !/^[0-9a-f]{64}$/.test(hex)) return false;
  // Always compute the HMAC (even for malformed input) so timing does not depend on the format
  const candidate = mac(userId, salt, EMAIL_CODE_PATTERN.test(code) ? code : '------', env);
  const expected = Buffer.from(hex, 'hex');
  return crypto.timingSafeEqual(candidate, expected) && EMAIL_CODE_PATTERN.test(code);
}

/** AES-256-GCM, bound to the user id (AAD). Output: v1.<base64(iv | tag | ciphertext)>. */
export function encryptVerificationCode(userId: string, code: string, env?: NodeJS.ProcessEnv): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', subKey('enc', env), iv);
  cipher.setAAD(Buffer.from(userId, 'utf8'));
  const ct = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return CIPHER_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Decrypts a stored code; null when it cannot be authenticated (wrong key, tampering, other user). */
export function decryptVerificationCode(userId: string, value: string | null | undefined, env?: NodeJS.ProcessEnv): string | null {
  if (typeof value !== 'string' || !value.startsWith(CIPHER_PREFIX)) return null;
  try {
    const raw = Buffer.from(value.slice(CIPHER_PREFIX.length), 'base64');
    if (raw.length < 12 + 16 + 1) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', subKey('enc', env), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(userId, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    const code = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    return EMAIL_CODE_PATTERN.test(code) ? code : null;
  } catch {
    return null;
  }
}
