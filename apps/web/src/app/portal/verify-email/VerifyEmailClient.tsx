'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import { ArrowRight, CircleAlert, CircleCheck, Loader2 } from 'lucide-react';
import { fetchApi, isApiErrorCode } from '@/lib/api-client';
import { announceEmailVerified } from '@/lib/email-verification-sync';

const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

type State =
  | { status: 'verifying' }
  | { status: 'success'; alreadyVerified?: boolean }
  | { status: 'failure'; title: string; message: string };

const INVALID_LINK: State = {
  status: 'failure',
  title: 'This link is invalid or has expired',
  message:
    'Verification links are valid for 24 hours and may be used once. Please sign in to the Team Portal and request a new verification email from the dashboard.'
};

/**
 * When the link cannot be used (missing, expired or already used), a signed-in captain whose address is
 * already verified is told so instead of being asked to request a new link.
 */
async function signedInAndVerified(): Promise<boolean> {
  try {
    const res = await fetchApi<{ user?: { emailVerified?: boolean } | null }>('/auth/me');
    return res?.user?.emailVerified === true;
  } catch {
    return false;
  }
}

/**
 * One verification request per token for the lifetime of the page: React re-runs effects in development
 * (Strict Mode, Fast Refresh), and a second POST would find the token already used. Every run awaits the
 * same promise, so the outcome always reaches the mounted component.
 */
const verifications = new Map<string, Promise<State>>();

async function runVerification(token: string): Promise<State> {
  if (!token) return (await signedInAndVerified()) ? { status: 'success', alreadyVerified: true } : INVALID_LINK;
  try {
    const res = await fetchApi<{ success?: boolean; alreadyVerified?: boolean }>('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token })
    });
    // Any open Team Portal tab re-reads the verification status at once
    announceEmailVerified();
    return { status: 'success', alreadyVerified: res?.alreadyVerified === true };
  } catch (err) {
    if (isApiErrorCode(err, 'INVALID_OR_EXPIRED_TOKEN')) {
      return (await signedInAndVerified()) ? { status: 'success', alreadyVerified: true } : INVALID_LINK;
    }
    // A transient failure may be retried by opening the link again
    verifications.delete(token);
    return {
      status: 'failure',
      title: 'Verification could not be completed',
      message:
        err instanceof Error && err.message
          ? `${err.message} Please open the link again in a few minutes.`
          : 'Please open the link again in a few minutes.'
    };
  }
}

function verifyOnce(token: string): Promise<State> {
  let pending = verifications.get(token);
  if (!pending) {
    pending = runVerification(token);
    verifications.set(token, pending);
  }
  return pending;
}

/** Calls POST /auth/verify-email once with the token from the link and reports the outcome. */
export default function VerifyEmailClient({ token: linkToken }: { token: string }) {
  const [state, setState] = useState<State>({ status: 'verifying' });
  // Read once: removing the token from the address bar below re-renders the page without it
  const [token] = useState(linkToken);

  useEffect(() => {
    // Keep the one-time token out of the address bar and browser history once it has been read.
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    let active = true;
    void verifyOnce(token).then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, [token]);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={state.status}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3, ease: EASE_OUT }}
          className="space-y-5"
        >
          {state.status === 'verifying' && (
            <p role="status" className="flex items-center justify-center gap-2 text-sm font-semibold text-slate-600">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Verifying your email address…
            </p>
          )}

          {state.status === 'success' && (
            <div role="status" className="space-y-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center">
              <CircleCheck className="mx-auto h-8 w-8 text-[#15803D]" aria-hidden="true" />
              <h2 className="text-base font-black text-emerald-950">
                {state.alreadyVerified ? 'Your email address is already verified' : 'Your email address has been verified'}
              </h2>
              <p className="text-sm text-emerald-900">
                You may now submit your team registration and pay the entry fee from the team dashboard.
              </p>
            </div>
          )}

          {state.status === 'failure' && (
            <div role="alert" className="space-y-2 rounded-2xl border border-rose-200 bg-rose-50 p-5 text-center">
              <CircleAlert className="mx-auto h-8 w-8 text-rose-600" aria-hidden="true" />
              <h2 className="text-base font-black text-rose-950">{state.title}</h2>
              <p className="text-sm text-rose-900">{state.message}</p>
            </div>
          )}

          {state.status !== 'verifying' && (
            <Link
              href="/portal"
              className="group flex w-full items-center justify-center gap-2 rounded-full bg-[#22C55E] py-3.5 text-xs font-black uppercase tracking-wider text-slate-950 shadow-md shadow-[#22C55E]/20 transition-[background-color,box-shadow,color] duration-200 hover:bg-[#15803D] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#15803D]"
            >
              <span>{state.status === 'success' ? 'Continue to the Team Portal' : 'Sign in to the Team Portal'}</span>
              <ArrowRight
                className="h-4 w-4 transition-transform duration-300 ease-out group-hover:translate-x-1 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </Link>
          )}
        </motion.div>
      </AnimatePresence>
    </MotionConfig>
  );
}
