/** Accepted certificate code format, for example GCDIS-CERT-2026-6C330230. Dependency-free for unit tests. */
export const CERTIFICATE_CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

/** Trim, upper-case and collapse internal whitespace to hyphens. Returns null when the code is not well-formed. */
export function normalizeCertificateCode(input: string): string | null {
  const code = input.trim().toUpperCase().replace(/\s+/g, '-');
  if (code.length < 4 || code.length > 64 || !CERTIFICATE_CODE_PATTERN.test(code)) return null;
  return code;
}

/** Format an ISO date as a formal date in Indian Standard Time, e.g. "11 October 2026". */
export function formatIssuedDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(date);
}
