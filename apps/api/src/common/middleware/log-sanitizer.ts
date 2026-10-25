import * as crypto from 'crypto';

/**
 * Query parameters whose values are credentials or one-time secrets (signed-URL tokens and expiries,
 * OAuth / verification codes, short signature parameters) and must never reach logs or error bodies.
 */
export const SENSITIVE_QUERY_KEYS: ReadonlySet<string> = new Set([
  'token',
  'expires',
  'code',
  'p',
  's',
  'sig',
  'signature',
  'state',
  'otp',
  'key',
  'secret',
  'password',
  'access_token',
  'refresh_token',
  'id_token'
]);

const REDACTED = '[REDACTED]';
const MAX_LOGGED_URL_LENGTH = 2048;

/** Client-supplied request IDs are accepted only in this shape (at most 64 characters). */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/**
 * The URL with the values of sensitive query parameters replaced by [REDACTED] (other parameters are
 * kept for debugging) and the result capped at 2048 characters. Used for request logs and the URL
 * echoed by the global exception filter.
 */
export function redactUrl(url: unknown): string {
  if (typeof url !== 'string' || url.length === 0) return '';
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex < 0) return withoutHash.slice(0, MAX_LOGGED_URL_LENGTH);

  const pathPart = withoutHash.slice(0, queryIndex);
  const query = withoutHash.slice(queryIndex + 1);
  const parts = query
    .split('&')
    .filter((part) => part.length > 0)
    .map((part) => {
      const eq = part.indexOf('=');
      const rawKey = eq >= 0 ? part.slice(0, eq) : part;
      const key = safeDecode(rawKey).trim().toLowerCase();
      return SENSITIVE_QUERY_KEYS.has(key) ? `${rawKey}=${REDACTED}` : part;
    });
  const result = parts.length > 0 ? `${pathPart}?${parts.join('&')}` : pathPart;
  return result.slice(0, MAX_LOGGED_URL_LENGTH);
}

/** The client's request ID when it is well-formed (string, 1-64 chars of [A-Za-z0-9_-]); otherwise null. */
export function validClientRequestId(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && REQUEST_ID_PATTERN.test(candidate) ? candidate : null;
}

/** A fresh server-generated request ID (matches REQUEST_ID_PATTERN). */
export function newRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}
