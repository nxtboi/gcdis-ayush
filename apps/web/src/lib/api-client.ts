/**
 * Unified API Client for GCDIS Public Portal
 * - Enforces NEXT_PUBLIC_API_URL (fails if missing)
 * - Uses credentials: 'include' for secure httpOnly cookie sessions
 * - Zero localStorage token storage
 * - Automatic single-retry refresh on 401 Unauthorized
 * - Surfaces real backend error messages
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

/** Socket.IO endpoint: explicit NEXT_PUBLIC_WS_URL, otherwise the API origin. */
export const SOCKET_URL: string = (() => {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  if (!API_BASE_URL) return '';
  try {
    return new URL(API_BASE_URL).origin;
  } catch {
    return '';
  }
})();

/** Resolve an API-relative asset path (e.g. `/api/uploads/files/x`) to an absolute URL on the API origin. */
export function resolveApiAssetUrl(url: string): string {
  if (!url || /^(https?:|data:|blob:)/i.test(url)) return url;
  let origin = '';
  try {
    origin = API_BASE_URL ? new URL(API_BASE_URL).origin : '';
  } catch {
    origin = '';
  }
  return `${origin}${url.startsWith('/') ? url : `/${url}`}`;
}

export function getApiBaseUrl(): string {
  if (!API_BASE_URL) {
    throw new Error('Configuration Error: NEXT_PUBLIC_API_URL environment variable is required. Build/runtime halted.');
  }
  return API_BASE_URL;
}

/**
 * Public site URL used for absolute links (QR verification links, sitemap).
 * Prefers NEXT_PUBLIC_SITE_URL, falls back to the current browser origin.
 */
export function getSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/$/, '');
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

interface FetchApiOptions extends RequestInit {
  _isRetry?: boolean;
}

let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

async function refreshSession(baseUrl: string): Promise<boolean> {
  if (isRefreshing && refreshPromise) {
    return refreshPromise;
  }

  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        }
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

export const SERVICE_UNAVAILABLE_MESSAGE =
  'The GCDIS service is temporarily unavailable. Please try again in a few minutes.';

export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';

/**
 * Dispatched on `window` when an authenticated request is rejected with 401 and the session could not be
 * refreshed. Pages holding signed-in state (e.g. the Team Portal) listen for it and return to sign-in.
 */
export const SESSION_EXPIRED_EVENT = 'gcdis:session-expired';

/** Shown when the API rejects an action because the captain has not yet verified the account email address. */
export const EMAIL_NOT_VERIFIED_MESSAGE =
  'Please verify your email address before submitting the registration or paying the entry fee. Use the link in the verification email, or request a new one from the banner at the top of the dashboard.';

/** Error thrown for non-2xx API responses; carries the HTTP status and the API error code, when present. */
export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable API error code, e.g. EMAIL_NOT_VERIFIED, WEAK_PASSWORD, INVALID_OR_EXPIRED_TOKEN. */
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** True when the error is an API error with the given code. */
export function isApiErrorCode(err: unknown, code: string): boolean {
  return err instanceof ApiError && err.code === code;
}

/** Auth endpoints never trigger a refresh-and-retry (credentials are being exchanged, not presented). */
function isAuthExchangeEndpoint(endpoint: string): boolean {
  return (
    endpoint.includes('/auth/login') ||
    endpoint.includes('/auth/google') ||
    endpoint.includes('/auth/refresh') ||
    // Token-based and anonymous account recovery endpoints never use the session
    endpoint.includes('/auth/verify-email') ||
    endpoint.includes('/auth/forgot-password') ||
    endpoint.includes('/auth/reset-password')
  );
}

function notifySessionExpired(endpoint: string): void {
  // /auth/me is the anonymous session probe: a 401 there simply means "not signed in".
  if (typeof window === 'undefined' || endpoint.includes('/auth/me') || endpoint.includes('/auth/logout')) return;
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

/** Extracts the API's error message and code from a failed response (NestJS `{ message, code }` bodies). */
async function readErrorBody(res: Response): Promise<{ message: string; code?: string }> {
  let message = `Request failed (HTTP ${res.status}).`;
  let code: string | undefined;
  try {
    const errorData = await res.json();
    if (Array.isArray(errorData.message)) {
      message = errorData.message.join(', ');
    } else if (errorData.message) {
      message = errorData.message;
    } else if (errorData.error) {
      message = errorData.error;
    }
    if (typeof errorData.code === 'string') code = errorData.code;
  } catch {
    // Non-JSON error response
  }
  if (code === 'EMAIL_NOT_VERIFIED') message = EMAIL_NOT_VERIFIED_MESSAGE;
  // The API's own rate-limit messages are formal; only a bare framework message is replaced.
  if (res.status === 429 && /^(ThrottlerException|Too Many Requests)/i.test(message)) {
    message = 'Too many requests have been made. Please wait a few minutes and try again.';
  }
  return { message, code };
}

async function readErrorMessage(res: Response): Promise<string> {
  return (await readErrorBody(res)).message;
}

export async function fetchApi<T = any>(
  endpoint: string,
  options: FetchApiOptions = {}
): Promise<T> {
  const baseUrl = getApiBaseUrl();
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${baseUrl}${cleanEndpoint}`;

  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers as Record<string, string>)
  };

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      credentials: 'include',
      headers
    });
  } catch {
    // Network failure / API unreachable: never surface raw browser errors to visitors.
    throw new Error(SERVICE_UNAVAILABLE_MESSAGE);
  }

  // Handle 401 Unauthorized: Attempt token refresh once
  if (res.status === 401 && !options._isRetry && !isAuthExchangeEndpoint(endpoint)) {
    const refreshed = await refreshSession(baseUrl);
    if (refreshed) {
      return fetchApi<T>(endpoint, {
        ...options,
        _isRetry: true
      });
    }
  }

  if (res.status === 401 && !isAuthExchangeEndpoint(endpoint)) {
    notifySessionExpired(endpoint);
    throw new ApiError(SESSION_EXPIRED_MESSAGE, 401);
  }

  if (res.status >= 500) {
    // Server-side failures can carry stack/ORM details in development; show a stable, friendly message instead.
    throw new Error(SERVICE_UNAVAILABLE_MESSAGE);
  }

  if (!res.ok) {
    const { message, code } = await readErrorBody(res);
    throw new ApiError(message, res.status, code);
  }

  // Handle 204 No Content
  if (res.status === 204) {
    return null as T;
  }

  // Endpoints that return `null` (e.g. GET /teams/my-team before a team exists) send an empty body
  const text = await res.text();
  if (!text) {
    return null as T;
  }
  return JSON.parse(text) as T;
}

/**
 * Authenticated file download helper
 * Replaces window.open with fetch blob stream using credentials: 'include'.
 * Like fetchApi, an expired access token is refreshed once before the download is retried.
 */
export async function downloadAuthenticatedFile(fileUrl: string, downloadName?: string): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const url = fileUrl.startsWith('http') ? fileUrl : `${baseUrl}${fileUrl.startsWith('/') ? fileUrl : `/${fileUrl}`}`;

  const request = async (): Promise<Response> => {
    try {
      return await fetch(url, { method: 'GET', credentials: 'include' });
    } catch {
      throw new Error(SERVICE_UNAVAILABLE_MESSAGE);
    }
  };

  let res = await request();
  if (res.status === 401 && (await refreshSession(baseUrl))) {
    res = await request();
  }

  if (res.status === 401) {
    notifySessionExpired(fileUrl);
    throw new ApiError(SESSION_EXPIRED_MESSAGE, 401);
  }
  if (res.status >= 500) {
    throw new ApiError(SERVICE_UNAVAILABLE_MESSAGE, res.status);
  }
  if (!res.ok) {
    throw new ApiError(`The file could not be downloaded. ${await readErrorMessage(res)}`, res.status);
  }

  const blob = await res.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = downloadName || fileUrl.split('/').pop() || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking synchronously can cancel the download in some browsers; release the blob shortly afterwards.
  window.setTimeout(() => window.URL.revokeObjectURL(blobUrl), 30_000);
}

/**
 * On-demand Razorpay Checkout Script Loader
 * Loads checkout script ONLY when user reaches the payment checkout screen
 */
export function loadRazorpayCheckout(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve(false);
      return;
    }

    if ((window as any).Razorpay) {
      resolve(true);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}
