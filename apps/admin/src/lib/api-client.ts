/**
 * Unified Admin Console API Client
 * - Enforces NEXT_PUBLIC_API_URL
 * - credentials: 'include' for secure httpOnly admin session cookies
 * - Handles single-retry on 401 Unauthorized
 * - Zero localStorage token dependencies
 */

const DEV_FALLBACK_API_URL = 'http://localhost:4000/api';

function resolveApiBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (url) return url.replace(/\/$/, '');
  // Local development convenience only; production builds must configure NEXT_PUBLIC_API_URL.
  if (process.env.NODE_ENV === 'development') return DEV_FALLBACK_API_URL;
  return '';
}

/** Base URL of the GCDIS REST API (including the `/api` prefix). Empty string when misconfigured. */
export const API_BASE_URL: string = resolveApiBaseUrl();

/** Origin of the API (scheme + host + port), used to resolve server-relative asset URLs. */
export const API_ORIGIN: string = (() => {
  if (!API_BASE_URL) return '';
  try {
    return new URL(API_BASE_URL).origin;
  } catch {
    return '';
  }
})();

export function getAdminApiBaseUrl(): string {
  if (!API_BASE_URL) {
    throw new Error('NEXT_PUBLIC_API_URL environment variable is required');
  }
  return API_BASE_URL;
}

/** Resolve an API-relative asset path (e.g. `/api/uploads/files/x`) to an absolute URL on the API origin. */
export function resolveApiAssetUrl(url: string): string {
  if (!url || /^(https?:|data:|blob:)/i.test(url)) return url;
  return `${API_ORIGIN}${url.startsWith('/') ? url : `/${url}`}`;
}

interface FetchOptions extends RequestInit {
  _isRetry?: boolean;
  /** Set on the single retry made after a successful step-up confirmation. */
  _isStepUpRetry?: boolean;
}

/** Thrown when an authenticated request fails because the session was revoked or has expired. */
export class SessionExpiredError extends Error {
  constructor(message = 'Session has been revoked or expired') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export function isSessionExpiredError(err: unknown): err is SessionExpiredError {
  return err instanceof SessionExpiredError;
}

/**
 * Endpoints whose 401 responses are part of the sign-in flow itself (wrong password, invalid code,
 * no session yet) and must not be treated as "the active session has ended".
 */
const SESSION_CHECK_EXEMPT = [
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
  '/auth/me',
  '/auth/2fa/',
  '/auth/change-password',
  '/auth/step-up'
];

type SessionExpiredHandler = (message: string, code?: string) => void;
let sessionExpiredHandler: SessionExpiredHandler | null = null;

/**
 * Register the console's handler for revoked/expired sessions (returns to the sign-in screen). `code` is the
 * API error code when there is one, e.g. SESSION_IDLE_TIMEOUT after the server-side inactivity limit.
 */
export function setSessionExpiredHandler(handler: SessionExpiredHandler | null): void {
  sessionExpiredHandler = handler;
}

/** API code of a staff session ended by the server-side idle timeout (ADMIN_IDLE_TIMEOUT_MIN). */
export const SESSION_IDLE_TIMEOUT_CODE = 'SESSION_IDLE_TIMEOUT';

// -------------------------------------------------------------
// ACTIVITY TRACKING (server-side idle timeout)
// -------------------------------------------------------------
/**
 * The API ends a staff session after ADMIN_IDLE_TIMEOUT_MIN minutes without activity. Requests made while the
 * user is not interacting with the console (badge polling on an unattended screen) are marked passive with this
 * header, so they do not keep the session alive. Omitting it only keeps a session alive, so it grants nothing.
 */
export const PASSIVE_REQUEST_HEADER = 'X-GCDIS-Passive';
/** A request counts as user activity when the user interacted with the console within this window. */
const ACTIVE_WINDOW_MS = 60_000;
/** While the user is active, the server is told at most this often (it records activity once a minute). */
const KEEP_ALIVE_INTERVAL_MS = 60_000;

let lastUserActivityAt = Date.now();
let lastActiveRequestAt = 0;

/** Records a user interaction (pointer, key, scroll) and, at most once a minute, tells the API the user is active. */
export function noteUserActivity(now: number = Date.now()): void {
  lastUserActivityAt = now;
  if (now - lastActiveRequestAt >= KEEP_ALIVE_INTERVAL_MS) {
    void keepSessionAlive().catch(() => undefined);
  }
}

/** True when the user interacted with the console recently (requests are then user activity). */
export function isUserActive(now: number = Date.now()): boolean {
  return now - lastUserActivityAt <= ACTIVE_WINDOW_MS;
}

/** Marks the session as active on the server ("Stay signed in"): GET /auth/me as an active request. */
export async function keepSessionAlive(): Promise<void> {
  lastActiveRequestAt = Date.now();
  try {
    await adminFetch('/auth/me');
  } catch (err) {
    // /auth/me is a session probe (exempt from the expiry handler): report a server-side idle sign-out here
    if (err instanceof ApiError && err.code === SESSION_IDLE_TIMEOUT_CODE) sessionExpiredHandler?.(err.message, err.code);
    throw err;
  }
}

/**
 * Normalises list responses: accepts a bare array, `{ items, total }` (withMeta) or a named
 * collection such as `{ registrations, total }` / `{ logs, total }`.
 */
export function toPagedResult<T>(data: unknown, key?: string): { items: T[]; total: number | null } {
  if (Array.isArray(data)) return { items: data as T[], total: null };
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const list = Array.isArray(record.items) ? record.items : key && Array.isArray(record[key]) ? record[key] : [];
    const total = typeof record.total === 'number' && Number.isFinite(record.total) ? record.total : null;
    return { items: list as T[], total };
  }
  return { items: [], total: null };
}

let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

async function refreshAdminSession(baseUrl: string): Promise<boolean> {
  if (isRefreshing && refreshPromise) return refreshPromise;
  isRefreshing = true;

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      // 409: another tab refreshed this session a moment ago; its response carries the new cookies
      if (res.status === 409) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return true;
      }
      return res.ok;
    } catch {
      return false;
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function adminFetch<T = any>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const baseUrl = getAdminApiBaseUrl();
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${baseUrl}${cleanEndpoint}`;

  // Let the browser set the multipart boundary for FormData uploads
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const active = isUserActive();
  if (active) lastActiveRequestAt = Date.now();
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(active ? {} : { [PASSIVE_REQUEST_HEADER]: '1' }),
    ...(options.headers as Record<string, string>)
  };

  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    headers
  });

  if (res.status === 401 && !options._isRetry && !endpoint.includes('/auth/login') && !endpoint.includes('/auth/refresh')) {
    const refreshed = await refreshAdminSession(baseUrl);
    if (refreshed) {
      return adminFetch<T>(endpoint, {
        ...options,
        _isRetry: true
      });
    }
  }

  if (res.status === 401 && !SESSION_CHECK_EXEMPT.some((path) => cleanEndpoint.startsWith(path))) {
    // Refresh failed (or the retried request was still rejected): the session is no longer valid
    let message = 'Session has been revoked or expired';
    let code: string | undefined;
    try {
      const errorData = await res.json();
      if (typeof errorData?.message === 'string' && errorData.message) message = errorData.message;
      if (typeof errorData?.code === 'string') code = errorData.code;
    } catch {
      // Non-JSON error
    }
    if (code !== undefined) sessionExpiredHandler?.(message, code);
    else sessionExpiredHandler?.(message);
    throw new SessionExpiredError(message);
  }

  if (!res.ok) {
    let errorData: any = null;
    try {
      errorData = await res.json();
    } catch {
      // Non-JSON error
    }

    // Sensitive actions need a recent re-authentication: ask for a code, then retry the request once
    if (isStepUpRequired(res.status, errorData) && !options._isStepUpRetry && !cleanEndpoint.startsWith('/auth/step-up')) {
      const confirmed = await requestStepUp();
      if (!confirmed) throw new StepUpCancelledError();
      return adminFetch<T>(endpoint, { ...options, _isStepUpRetry: true });
    }

    throw new ApiError(errorMessageOf(errorData, `HTTP ${res.status}: ${res.statusText}`), res.status, errorData?.code);
  }

  if (res.status === 204) return null as T;

  // Some endpoints answer 200/201 with an empty body
  try {
    return (await res.json()) as T;
  } catch {
    return null as T;
  }
}

/** Error raised for a non-2xx API response; keeps the HTTP status and the API error code when present. */
export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function errorMessageOf(errorData: any, fallback: string): string {
  if (!errorData || typeof errorData !== 'object') return fallback;
  if (Array.isArray(errorData.message)) return errorData.message.join(', ');
  if (typeof errorData.message === 'string' && errorData.message) return errorData.message;
  if (typeof errorData.error === 'string' && errorData.error) return errorData.error;
  return fallback;
}

// -------------------------------------------------------------
// STEP-UP RE-AUTHENTICATION
// -------------------------------------------------------------
export const STEP_UP_REQUIRED_CODE = 'STEP_UP_REQUIRED';
export const STEP_UP_CANCELLED_MESSAGE =
  'The action was cancelled because your identity was not confirmed. No changes have been made.';

/** Thrown when the user cancels the identity confirmation requested for a sensitive action. */
export class StepUpCancelledError extends Error {
  constructor(message = STEP_UP_CANCELLED_MESSAGE) {
    super(message);
    this.name = 'StepUpCancelledError';
  }
}

export function isStepUpCancelledError(err: unknown): err is StepUpCancelledError {
  return err instanceof StepUpCancelledError;
}

/** True for the API's 403 answer to a sensitive action without a recent step-up. */
export function isStepUpRequired(status: number, body: unknown): boolean {
  return status === 403 && !!body && typeof body === 'object' && (body as { code?: unknown }).code === STEP_UP_REQUIRED_CODE;
}

/**
 * Prompts for an authenticator or recovery code, calls POST /auth/step-up and resolves true once the
 * step-up succeeded, or false when the user cancelled. Registered by the console's step-up dialog.
 */
type StepUpHandler = () => Promise<boolean>;
let stepUpHandler: StepUpHandler | null = null;
let pendingStepUp: Promise<boolean> | null = null;

export function setStepUpHandler(handler: StepUpHandler | null): void {
  stepUpHandler = handler;
}

/** Concurrent requests that need a step-up share one prompt. */
function requestStepUp(): Promise<boolean> {
  if (!stepUpHandler) return Promise.resolve(false);
  if (!pendingStepUp) {
    pendingStepUp = stepUpHandler()
      .catch(() => false)
      .finally(() => {
        pendingStepUp = null;
      });
  }
  return pendingStepUp;
}

/** POST /auth/step-up with the six-digit authenticator code or a recovery code. */
export async function submitStepUpCode(code: string): Promise<{ stepUpUntil?: string } | null> {
  return adminFetch<{ stepUpUntil?: string }>('/auth/step-up', {
    method: 'POST',
    body: JSON.stringify({ code: code.trim() })
  });
}

// -------------------------------------------------------------
// FILE UPLOADS WITH PROGRESS
// -------------------------------------------------------------
export interface UploadResult {
  assetId?: string;
  fileName?: string;
  fileUrl: string;
  mimeType?: string;
  sizeBytes?: number;
  isPublic?: boolean;
}

function sendUpload(url: string, form: FormData, onProgress?: (percent: number) => void): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      let body: any = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new Error('Failed to fetch'));
    xhr.onabort = () => reject(new Error('The upload was cancelled.'));
    xhr.send(form);
  });
}

/**
 * Uploads one file to POST /uploads/stream with the given purpose, reporting progress (0 to 100).
 * Handles an expired access token (one refresh and retry) like every other console request.
 */
export async function uploadAdminFile(file: File, purpose: string, onProgress?: (percent: number) => void): Promise<UploadResult> {
  const baseUrl = getAdminApiBaseUrl();
  // The purpose is also sent on the URL: the API picks the multipart size limit before reading the body
  // (25 MB; larger only for the championship hero video, EVENT_VIDEO)
  const url = `${baseUrl}/uploads/stream?purpose=${encodeURIComponent(purpose)}`;
  const makeForm = () => {
    const form = new FormData();
    form.append('file', file);
    form.append('purpose', purpose);
    return form;
  };

  let result = await sendUpload(url, makeForm(), onProgress);
  if (result.status === 401 && (await refreshAdminSession(baseUrl))) {
    result = await sendUpload(url, makeForm(), onProgress);
  }
  if (result.status === 401) {
    const message = errorMessageOf(result.body, 'Session has been revoked or expired');
    sessionExpiredHandler?.(message);
    throw new SessionExpiredError(message);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new ApiError(errorMessageOf(result.body, `HTTP ${result.status}`), result.status, result.body?.code);
  }
  if (!result.body || typeof result.body.fileUrl !== 'string') {
    throw new Error('The server did not return the address of the uploaded file.');
  }
  onProgress?.(100);
  return result.body as UploadResult;
}

/**
 * Downloads CSV export from /audit/export with credentials
 */
export async function downloadAuditCsv(params?: Record<string, string>): Promise<void> {
  const baseUrl = getAdminApiBaseUrl();
  const query = new URLSearchParams(params || {}).toString();
  const url = `${baseUrl}/audit/export?format=csv${query ? `&${query}` : ''}`;

  const request = () => fetch(url, { method: 'GET', credentials: 'include' });
  let res = await request();

  // An expired access token is refreshed once, as for every other console request
  if (res.status === 401 && (await refreshAdminSession(baseUrl))) {
    res = await request();
  }
  if (res.status === 401) {
    const body = await res.json().catch(() => null);
    const message = typeof body?.message === 'string' && body.message ? body.message : 'Session has been revoked or expired';
    sessionExpiredHandler?.(message, typeof body?.code === 'string' ? body.code : undefined);
    throw new SessionExpiredError(message);
  }
  // Exporting the audit log requires a recent identity confirmation: ask for a code, then retry once
  if (res.status === 403) {
    const body = await res.clone().json().catch(() => null);
    if (isStepUpRequired(res.status, body)) {
      const confirmed = await requestStepUp();
      if (!confirmed) throw new StepUpCancelledError();
      res = await request();
    }
  }
  if (!res.ok) {
    throw new Error(`The audit log export failed (HTTP ${res.status}).`);
  }

  const blob = await res.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = `gcdis-audit-log-${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking immediately can cancel the download in some browsers; release the object URL shortly after
  window.setTimeout(() => window.URL.revokeObjectURL(blobUrl), 10_000);
}

// -------------------------------------------------------------
// AUDIT CHAIN VERIFICATION
// -------------------------------------------------------------
export interface AuditChainReport {
  ok: boolean;
  checkedRows: number;
  legacyRows: number;
  headSeq: number | null;
  headHash: string | null;
  firstBreak: {
    id: string | null;
    chainSeq: number | null;
    createdAt: string | null;
    action: string | null;
    reason: string;
    message: string;
  } | null;
  verifiedAt: string;
}

/** GET /audit/verify-chain (Super Administrator): verifies the audit log hash chain. */
export async function verifyAuditChain(): Promise<AuditChainReport> {
  return adminFetch<AuditChainReport>('/audit/verify-chain');
}
