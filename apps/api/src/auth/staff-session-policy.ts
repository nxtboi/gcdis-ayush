import { UnauthorizedException } from '@nestjs/common';

/**
 * Staff (admin-audience) session policy: idle timeout, concurrent session cap and the device / network
 * fingerprint used for new-device sign-in alerts. Public (team captain) sessions are not affected.
 */

/** Default idle timeout of a staff session, in minutes (ADMIN_IDLE_TIMEOUT_MIN). */
export const DEFAULT_ADMIN_IDLE_TIMEOUT_MIN = 30;
/** Default maximum number of concurrent staff sessions per account (ADMIN_MAX_SESSIONS). */
export const DEFAULT_ADMIN_MAX_SESSIONS = 3;
/** Session.lastSeenAt is written at most this often per session. */
export const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;
/** Look-back window for known devices / networks of a staff account. */
export const STAFF_DEVICE_HISTORY_DAYS = 30;

/** 401 code answered once a staff session has been idle for longer than the idle timeout. */
export const SESSION_IDLE_TIMEOUT_CODE = 'SESSION_IDLE_TIMEOUT';
/** Session.revokedReason values written by the server. */
export const REVOKED_IDLE_TIMEOUT = 'IDLE_TIMEOUT';
export const REVOKED_SESSION_LIMIT = 'SESSION_LIMIT';

/**
 * Request header the staff console sets on background requests (badge polling while nobody is using the
 * console). Such requests are authenticated normally but do not count as activity for the idle timeout.
 * Omitting it only keeps a session alive, exactly like real activity, so it grants nothing.
 */
export const PASSIVE_REQUEST_HEADER = 'x-gcdis-passive';

/** ADMIN_IDLE_TIMEOUT_MIN (default 30), clamped to 5..720 minutes. */
export function adminIdleTimeoutMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ADMIN_IDLE_TIMEOUT_MIN);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ADMIN_IDLE_TIMEOUT_MIN;
  return Math.min(Math.max(Math.round(raw), 5), 720);
}

export function adminIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return adminIdleTimeoutMinutes(env) * 60 * 1000;
}

/** ADMIN_MAX_SESSIONS (default 3), clamped to 1..20. */
export function adminMaxSessions(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ADMIN_MAX_SESSIONS);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_ADMIN_MAX_SESSIONS;
  return Math.min(Math.round(raw), 20);
}

/** Last activity of a session: lastSeenAt, else the last refresh, else its creation. */
export function sessionLastActivity(session: {
  lastSeenAt?: Date | string | null;
  lastUsedAt?: Date | string | null;
  createdAt?: Date | string | null;
}): number {
  for (const value of [session.lastSeenAt, session.lastUsedAt, session.createdAt]) {
    if (!value) continue;
    const t = new Date(value).getTime();
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

/** True when a staff session has had no activity for longer than the idle timeout. */
export function isSessionIdle(
  session: Parameters<typeof sessionLastActivity>[0],
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return now - sessionLastActivity(session) > adminIdleTimeoutMs(env);
}

/** 401 { code: 'SESSION_IDLE_TIMEOUT', message }. */
export function sessionIdleTimeoutException(env: NodeJS.ProcessEnv = process.env): UnauthorizedException {
  const minutes = adminIdleTimeoutMinutes(env);
  return new UnauthorizedException({
    statusCode: 401,
    code: SESSION_IDLE_TIMEOUT_CODE,
    error: 'Unauthorized',
    message: `You were signed out after ${minutes} minutes of inactivity.`
  });
}

/** True when the request was marked as a background (passive) request by the console. */
export function isPassiveRequest(req: any): boolean {
  const value = req?.headers?.[PASSIVE_REQUEST_HEADER];
  return value === '1' || value === 'true';
}

/**
 * Network of an address for new-location detection: the /24 of an IPv4 address (IPv4-mapped IPv6 included)
 * and the /64 of an IPv6 address. Unknown or malformed input yields the trimmed input itself.
 */
export function ipNetworkOf(ip?: string | null): string {
  let value = String(ip || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value.startsWith('::ffff:') && value.includes('.')) value = value.slice(7);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (value.includes(':')) {
    const [head] = value.split('%');
    const parts = expandIpv6(head);
    if (parts) return `${parts.slice(0, 4).join(':')}::/64`;
  }
  return value;
}

function expandIpv6(value: string): string[] | null {
  if (!/^[0-9a-f:]+$/.test(value)) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && left.length !== 8) return null;
  if (missing < 0) return null;
  const all = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (all.length !== 8 || all.some((p) => p.length === 0 || p.length > 4)) return null;
  return all.map((p) => p.replace(/^0+(?=.)/, ''));
}

/**
 * Browser family and operating system of a User-Agent ("Chrome on Windows"), ignoring versions, so that a
 * browser update is not a new device. Unknown agents yield "Other on Other".
 */
export function userAgentFamily(userAgent?: string | null): string {
  const ua = String(userAgent || '');
  let browser = 'Other';
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser\//.test(ua)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\/|Chromium\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'Safari';
  else if (/curl\//i.test(ua)) browser = 'curl';

  let os = 'Other';
  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return `${browser} on ${os}`;
}
