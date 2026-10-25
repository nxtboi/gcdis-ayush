/**
 * Client-side mirror of the API password policy (register, change and reset password):
 * at least 12 characters; at least three of lower case, upper case, digit and symbol; not containing the name part
 * of the account email address; and not a known breached password. The breach check runs on the server only
 * (Have I Been Pwned range API); the API answers 400 `{ code: 'WEAK_PASSWORD', message }` when any rule fails.
 */

export const PASSWORD_MIN_LENGTH = 12;
/** Upper bound enforced by the API (protects bcrypt from oversized input). */
export const PASSWORD_MAX_LENGTH = 128;

export interface PasswordCheck {
  id: 'length' | 'classes' | 'email' | 'breached';
  label: string;
  /** null when the rule can only be checked by the server. */
  met: boolean | null;
}

export function countCharacterClasses(password: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
}

/**
 * The name part of an email address (before "@"), lower-cased; empty when unavailable or shorter than three
 * characters (the API ignores very short name parts, which would reject almost any password).
 */
export function emailLocalPart(email: string | undefined | null): string {
  const value = (email ?? '').trim().toLowerCase();
  const at = value.indexOf('@');
  const local = at > 0 ? value.slice(0, at) : '';
  return local.length >= 3 ? local : '';
}

export function passwordChecks(password: string, email?: string | null): PasswordCheck[] {
  const local = emailLocalPart(email);
  return [
    { id: 'length', label: `At least ${PASSWORD_MIN_LENGTH} characters`, met: password.length >= PASSWORD_MIN_LENGTH },
    {
      id: 'classes',
      label: 'At least three of: lower-case letters, upper-case letters, numbers and symbols',
      met: countCharacterClasses(password) >= 3
    },
    {
      id: 'email',
      label: 'Does not contain the name part of your email address',
      met: !local ? null : !password.toLowerCase().includes(local)
    },
    { id: 'breached', label: 'Not a password known from published data breaches (checked on submission)', met: null }
  ];
}

/** True when every rule that can be checked locally is met. */
export function passwordMeetsLocalPolicy(password: string, email?: string | null): boolean {
  return passwordChecks(password, email).every((c) => c.met !== false);
}

/** Formal message for the first unmet local rule, or null. */
export function passwordPolicyError(password: string, email?: string | null): string | null {
  if (password.length > PASSWORD_MAX_LENGTH) return `The password must not exceed ${PASSWORD_MAX_LENGTH} characters.`;
  const failed = passwordChecks(password, email).find((c) => c.met === false);
  if (!failed) return null;
  switch (failed.id) {
    case 'length':
      return `The password must contain at least ${PASSWORD_MIN_LENGTH} characters.`;
    case 'classes':
      return 'The password must contain at least three of the following: lower-case letters, upper-case letters, numbers and symbols.';
    case 'email':
      return 'The password must not contain the name part of your email address.';
    default:
      return null;
  }
}
