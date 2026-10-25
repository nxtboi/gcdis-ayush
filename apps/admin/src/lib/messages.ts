/**
 * Formal wording for API messages shown in the staff console.
 * The API remains the source of truth; only the presentation is adjusted here.
 */
const KNOWN_MESSAGES: [RegExp, string][] = [
  [/^invalid email or password\.?$/i, 'The email address or password is incorrect.'],
  [/^account has been deactivated/i, 'This account has been deactivated. Please contact the GCDIS Secretariat.'],
  [/^user not found or (account deactivated|inactive)\.?$/i, 'This account is not available. Please contact the GCDIS Secretariat.'],
  [/^invalid two-factor authentication code or recovery code\.?$/i, 'The authentication code or recovery code is not valid. Please try again.'],
  [/^invalid two-factor confirmation code\.?$/i, 'The authentication code is not valid. Please try again.'],
  [/^two-factor authentication code is required\.?$/i, 'Please enter the six-digit authentication code.'],
  [/^(invalid or expired 2fa challenge token|missing 2fa challenge token|invalid 2fa challenge token type)\.?$/i,
    'The verification step has expired. Please return to sign-in and start again.'],
  [/^current password does not match\.?$/i, 'The current password is incorrect.'],
  [/^password must be at least 12 characters long\.?$/i, 'The password must be at least 12 characters long.'],
  [/^password must be at least 14 characters long\.?$/i, 'The password must be at least 14 characters long.'],
  [/^user with this email already exists\.?$/i, 'An account with this email address already exists.'],
  [/^only super administrator can provision staff accounts\.?$/i, 'Only a Super Administrator can create staff accounts.'],
  [/^your account role is not permitted to perform this action\.?$/i, 'Your role does not permit this action.'],
  [/^session has been revoked or expired\.?$/i, 'Your session has ended. Please sign in again.'],
  [/^(throttlerexception: )?too many requests\.?$/i, 'Too many requests have been made. Please wait a moment and try again.'],
  [/^failed to fetch$|^networkerror|^load failed$/i, 'The server could not be reached. Please check the connection and try again.'],
  [/^(recent )?(step-up|re-?authentication) (is )?required/i, 'Please confirm your identity with an authentication code to continue.'],
  [/^invalid (step-up|authentication) code/i, 'The authentication code or recovery code is not valid. Please try again.'],
  [/^http 413\b|file too large|payload too large/i, 'The file is larger than the permitted size.'],
  [/^http 403\b/i, 'You do not have permission to perform this action.'],
  [/^http 404\b/i, 'The requested record could not be found.'],
  [/^http 5\d\d\b/i, 'The server could not complete the request. Please try again later.']
];

/** Rewrites a known API message formally; any other message is returned as a complete sentence. */
export function formalMessage(message: string): string {
  const trimmed = message.trim().replace(/!+$/, '.');
  for (const [pattern, replacement] of KNOWN_MESSAGES) {
    if (pattern.test(trimmed)) return replacement;
  }
  if (!trimmed) return trimmed;
  const sentence = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** Formal, complete-sentence message for a failed request. */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? formalMessage(err.message) : fallback;
}
