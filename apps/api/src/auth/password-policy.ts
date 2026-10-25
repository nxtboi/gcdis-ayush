/**
 * Password policy (security round 3), shared by the API and the bootstrap-admin script.
 *
 *  - 12 to 128 characters (the upper bound protects bcrypt from oversized input); staff accounts (Super
 *    Administrator, Event Administrator, Judge, Technical Inspector) need at least 14 characters when they
 *    set a new password (existing passwords are not affected until they are changed)
 *  - at least three of: lower case, upper case, digit, symbol
 *  - must not contain the local part of the account email address
 *  - must not appear in the Have I Been Pwned breached-password corpus (k-anonymity range API:
 *    only the first five characters of the SHA-1 hash leave the server; 2-second timeout;
 *    fails open with a logged warning; disabled with HIBP_CHECK=false)
 *
 * This module is framework-free on purpose so that prisma/bootstrap-admin.ts can import it.
 */
import * as crypto from 'crypto';

export const PASSWORD_MIN_LENGTH = 12;
/** Minimum length for staff accounts (new and changed passwords). */
export const STAFF_PASSWORD_MIN_LENGTH = 14;

const STAFF_ROLE_NAMES = new Set(['SUPER_ADMIN', 'EVENT_ADMIN', 'JUDGE', 'INSPECTOR']);

/** Minimum password length for an account role: 14 for staff roles, 12 otherwise. */
export function passwordMinLengthForRole(role?: string | null): number {
  return typeof role === 'string' && STAFF_ROLE_NAMES.has(role) ? STAFF_PASSWORD_MIN_LENGTH : PASSWORD_MIN_LENGTH;
}

/** Formal message for a password shorter than the given minimum. */
export function passwordTooShortMessage(minLength: number = PASSWORD_MIN_LENGTH): string {
  return `The password must be at least ${minLength} characters long.`;
}

/** Options shared by the policy checks. */
export interface PasswordRuleOptions {
  /** Minimum length (default PASSWORD_MIN_LENGTH; STAFF_PASSWORD_MIN_LENGTH for staff accounts). */
  minLength?: number;
}
export const PASSWORD_MAX_LENGTH = 128;

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const HIBP_TIMEOUT_MS = 2000;

export type PasswordPolicyResult = { ok: true } | { ok: false; reason: PasswordPolicyReason; message: string };

export type PasswordPolicyReason = 'TOO_SHORT' | 'TOO_LONG' | 'CHARACTER_CLASSES' | 'CONTAINS_EMAIL' | 'BREACHED';

export const PASSWORD_POLICY_MESSAGES: Readonly<Record<PasswordPolicyReason, string>> = Object.freeze({
  TOO_SHORT: `The password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
  TOO_LONG: `The password must not exceed ${PASSWORD_MAX_LENGTH} characters.`,
  CHARACTER_CLASSES:
    'The password must contain at least three of the following: lower-case letters, upper-case letters, digits and symbols.',
  CONTAINS_EMAIL: 'The password must not contain the name part of your email address.',
  BREACHED:
    'This password has appeared in a known data breach and cannot be used. Please choose a different password.'
});

type Logger = { warn: (message: string) => void };

/** HIBP is on by default; HIBP_CHECK=false disables it. Under Jest (NODE_ENV=test) it is off unless HIBP_CHECK=true. */
export function isHibpCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.HIBP_CHECK ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off') return false;
  if (raw === 'true' || raw === '1' || raw === 'on') return true;
  return env.NODE_ENV !== 'test';
}

/** Synchronous rules (length, character classes, email local part). Returns the first failure or null. */
export function checkPasswordRules(password: unknown, email?: string | null, rules: PasswordRuleOptions = {}): PasswordPolicyResult {
  const minLength = Math.max(rules.minLength ?? PASSWORD_MIN_LENGTH, PASSWORD_MIN_LENGTH);
  if (typeof password !== 'string' || password.length < minLength) {
    return minLength === PASSWORD_MIN_LENGTH ? fail('TOO_SHORT') : { ok: false, reason: 'TOO_SHORT', message: passwordTooShortMessage(minLength) };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return fail('TOO_LONG');
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    return fail('CHARACTER_CLASSES');
  }

  const localPart = typeof email === 'string' ? email.split('@')[0].trim().toLowerCase() : '';
  // Very short local parts (e.g. "a@x.org") would reject almost any password; ignore them.
  if (localPart.length >= 3 && password.toLowerCase().includes(localPart)) {
    return fail('CONTAINS_EMAIL');
  }

  return { ok: true };
}

/**
 * Queries the HIBP range API. Resolves true (breached), false (not found) or null (unknown: disabled,
 * timeout, network or HTTP error). Never throws.
 */
export async function isPasswordBreached(
  password: string,
  options: { logger?: Logger; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<boolean | null> {
  if (!isHibpCheckEnabled()) return null;
  const logger = options.logger ?? { warn: (m: string) => console.warn(m) };
  const fetchImpl = options.fetchImpl ?? (globalThis as any).fetch;
  if (typeof fetchImpl !== 'function') {
    logger.warn('[PasswordPolicy] fetch is unavailable; the breached-password check was skipped.');
    return null;
  }

  const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? HIBP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${HIBP_RANGE_URL}${prefix}`, {
      method: 'GET',
      headers: { 'Add-Padding': 'true', 'User-Agent': 'GCDIS-Platform-PasswordPolicy' },
      signal: controller.signal
    });
    if (!res || !res.ok) {
      logger.warn(`[PasswordPolicy] Breached-password service answered HTTP ${res?.status}; check skipped (fail open).`);
      return null;
    }
    const body = await res.text();
    for (const line of body.split('\n')) {
      const [hashSuffix, count] = line.trim().split(':');
      // Padding entries carry a count of 0 and never match a real password
      if (hashSuffix && hashSuffix.toUpperCase() === suffix && Number(count) > 0) {
        return true;
      }
    }
    return false;
  } catch (err: any) {
    const reason = err?.name === 'AbortError' ? 'timed out' : 'failed';
    logger.warn(`[PasswordPolicy] Breached-password check ${reason}; check skipped (fail open).`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Full policy: synchronous rules first, then the breached-password lookup. */
export async function evaluatePasswordPolicy(
  password: unknown,
  email?: string | null,
  options: { logger?: Logger; fetchImpl?: typeof fetch; minLength?: number } = {}
): Promise<PasswordPolicyResult> {
  const rules = checkPasswordRules(password, email, { minLength: options.minLength });
  if (!rules.ok) return rules;
  const breached = await isPasswordBreached(password as string, options);
  if (breached === true) return fail('BREACHED');
  return { ok: true };
}

function fail(reason: PasswordPolicyReason): PasswordPolicyResult {
  return { ok: false, reason, message: PASSWORD_POLICY_MESSAGES[reason] };
}
