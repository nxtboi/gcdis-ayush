'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { fetchApi } from '@/lib/api-client';

/** Minimal typing for the Google Identity Services client used here. */
interface GoogleCredentialResponse {
  credential?: string;
  select_by?: string;
}

interface GoogleAccountsId {
  initialize: (config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    ux_mode?: 'popup' | 'redirect';
    auto_select?: boolean;
    itp_support?: boolean;
    cancel_on_tap_outside?: boolean;
  }) => void;
  renderButton: (
    parent: HTMLElement,
    options: {
      type?: 'standard' | 'icon';
      theme?: 'outline' | 'filled_blue' | 'filled_black';
      size?: 'large' | 'medium' | 'small';
      shape?: 'rectangular' | 'pill' | 'circle' | 'square';
      text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
      logo_alignment?: 'left' | 'center';
      width?: number;
    }
  ) => void;
  disableAutoSelect: () => void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const MAX_BUTTON_WIDTH = 400;
const MIN_BUTTON_WIDTH = 200;
const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

let gsiScriptPromise: Promise<boolean> | null = null;

interface GoogleAuthConfig {
  enabled?: boolean;
  clientId?: string;
}

let configPromise: Promise<GoogleAuthConfig | null> | null = null;

/**
 * GET /auth/google/config once per page. Both portal forms render this button and React remounts it
 * whenever the form is switched, so without this cache the same configuration was requested repeatedly.
 */
function loadGoogleConfig(): Promise<GoogleAuthConfig | null> {
  if (!configPromise) {
    configPromise = fetchApi<GoogleAuthConfig>('/auth/google/config').catch(() => {
      configPromise = null; // allow a later retry after a transient failure
      return null;
    });
  }
  return configPromise;
}

/** Injects the GIS client script once per page; resolves false if it is blocked or fails. */
function loadGsiScript(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.google?.accounts?.id) return Promise.resolve(true);
  if (gsiScriptPromise) return gsiScriptPromise;

  gsiScriptPromise = new Promise<boolean>((resolve) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(Boolean(window.google?.accounts?.id));
    script.onerror = () => {
      gsiScriptPromise = null; // allow a later retry (e.g. after a network blip)
      script.remove();
      resolve(false);
    };
    document.head.appendChild(script);
  });
  return gsiScriptPromise;
}

// GIS must be initialised once per page; the active button instance receives credentials via this ref.
let initializedClientId: string | null = null;
const activeCallback: {
  current: ((response: GoogleCredentialResponse) => void) | null;
} = { current: null };

export interface GoogleAuthUser {
  id?: string;
  email: string;
  fullName?: string;
  phone?: string;
  role?: string;
}

interface GoogleSignInButtonProps {
  mode: 'login' | 'register';
  onGoogleSuccess: (user: GoogleAuthUser) => void;
  onGoogleError: (message: string) => void;
  disabled?: boolean;
}

/**
 * "Continue with Google" for team captains, using the official Google-rendered button
 * (Google Identity Services, popup ID-token flow). Renders nothing when the API reports
 * Google sign-in as disabled or the GIS script cannot load.
 */
export default function GoogleSignInButton({ mode, onGoogleSuccess, onGoogleError, disabled = false }: GoogleSignInButtonProps) {
  const reduceMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const successRef = useRef(onGoogleSuccess);
  const errorRef = useRef(onGoogleError);
  successRef.current = onGoogleSuccess;
  errorRef.current = onGoogleError;

  // 1. Ask the API whether Google sign-in is configured.
  useEffect(() => {
    let cancelled = false;
    // Config unavailable (null): keep the button hidden; password sign-in still works.
    void loadGoogleConfig().then((cfg) => {
      if (!cancelled && cfg?.enabled && typeof cfg.clientId === 'string' && cfg.clientId) {
        setClientId(cfg.clientId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCredential = useCallback(async (response: GoogleCredentialResponse) => {
    if (!response?.credential) {
      errorRef.current('Google sign-in was cancelled or did not complete. Please try again.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetchApi<{ user?: GoogleAuthUser }>('/auth/google', {
        method: 'POST',
        body: JSON.stringify({ credential: response.credential })
      });
      if (res?.user) {
        successRef.current(res.user);
      } else {
        errorRef.current('Google sign-in failed. Please try again.');
      }
    } catch (err) {
      errorRef.current(err instanceof Error && err.message ? err.message : 'Google sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }, []);

  // 2. Load GIS and initialise once per client id.
  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    activeCallback.current = handleCredential;

    loadGsiScript().then((loaded) => {
      if (cancelled) return;
      if (!loaded || !window.google) {
        setUnavailable(true); // blocked by an extension / network: hide, password sign-in still works
        return;
      }
      if (initializedClientId !== clientId) {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => activeCallback.current?.(response),
          ux_mode: 'popup',
          auto_select: false,
          itp_support: true
        });
        initializedClientId = clientId;
      }
      setReady(true);
    });

    return () => {
      cancelled = true;
      if (activeCallback.current === handleCredential) activeCallback.current = null;
    };
  }, [clientId, handleCredential]);

  // 3. Render the official button at the container width (capped at 400px), re-rendering on resize.
  useEffect(() => {
    const el = containerRef.current;
    if (!ready || !el || !window.google) return;

    let lastWidth = 0;
    const render = () => {
      const width = Math.max(MIN_BUTTON_WIDTH, Math.min(MAX_BUTTON_WIDTH, Math.floor(el.clientWidth)));
      if (width === lastWidth) return;
      lastWidth = width;
      el.innerHTML = '';
      window.google?.accounts.id.renderButton(el, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        logo_alignment: 'left',
        width
      });
    };
    render();

    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ready]);

  if (!clientId || unavailable) return null;

  const caption =
    mode === 'register'
      ? 'Continuing with Google creates a team captain account using your verified Google email address. Team details may then be completed from the dashboard.'
      : 'Team captains may sign in with the Google account that matches their registered email address.';

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.3, ease: EASE_OUT }}
      className="space-y-3 pt-1"
    >
      <div className="flex items-center gap-3" role="separator" aria-label="or">
        <span className="h-px flex-1 bg-slate-200" aria-hidden="true" />
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400" aria-hidden="true">
          or
        </span>
        <span className="h-px flex-1 bg-slate-200" aria-hidden="true" />
      </div>

      <div className="relative">
        <div
          ref={containerRef}
          aria-label={mode === 'register' ? 'Create captain account with Google' : 'Sign in with Google'}
          className={`mx-auto flex min-h-[44px] w-full max-w-[400px] justify-center transition-opacity duration-200 ${
            busy || disabled ? 'pointer-events-none opacity-60' : ''
          }`}
        />
        {!ready && (
          <div
            className="absolute inset-0 mx-auto flex max-w-[400px] items-center justify-center rounded-full border border-slate-200 bg-slate-50"
            aria-hidden="true"
          >
            <Loader2 className={`h-4 w-4 text-slate-400 ${reduceMotion ? '' : 'animate-spin'}`} />
          </div>
        )}
        {busy && (
          <div
            role="status"
            className="absolute inset-0 mx-auto flex max-w-[400px] items-center justify-center gap-2 rounded-full bg-white/80 text-xs font-bold text-slate-700"
          >
            <Loader2 className={`h-4 w-4 ${reduceMotion ? '' : 'animate-spin'}`} aria-hidden="true" />
            <span>Verifying Google account…</span>
          </div>
        )}
      </div>

      <p className="text-center text-[11px] leading-snug text-slate-500">{caption}</p>
    </motion.div>
  );
}
