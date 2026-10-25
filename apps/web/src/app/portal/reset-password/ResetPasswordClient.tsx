'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import { AlertCircle, ArrowRight, CircleAlert, CircleCheck } from 'lucide-react';
import { fetchApi, isApiErrorCode } from '@/lib/api-client';
import { passwordPolicyError } from '@/lib/password-policy';
import { Field, PasswordInput, SubmitButton } from '../_components/AuthFields';
import { PasswordPolicy } from '../_components/PasswordPolicy';

const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

const INVALID_LINK_MESSAGE =
  'This password reset link is invalid or has expired. Reset links are valid for 30 minutes and may be used once. Please request a new link.';

type Status = 'form' | 'success' | 'invalid';

const primaryLink =
  'group flex w-full items-center justify-center gap-2 rounded-full bg-[#22C55E] py-3.5 text-xs font-black uppercase tracking-wider text-slate-950 shadow-md shadow-[#22C55E]/20 transition-[background-color,box-shadow,color] duration-200 hover:bg-[#15803D] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#15803D]';

const arrow =
  'h-4 w-4 transition-transform duration-300 ease-out group-hover:translate-x-1 motion-reduce:transition-none';

/** New password form for a reset link (POST /auth/reset-password). */
/** The link's token is kept for this tab only, so reloading the page does not lose a still-valid link. */
const TOKEN_STORAGE_KEY = 'gcdis.portal.resetToken';

function storeToken(value: string | null): void {
  try {
    if (value) window.sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    else window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable: a reload then needs the emailed link again
  }
}

export default function ResetPasswordClient({ token: linkToken }: { token: string }) {
  const [token, setToken] = useState(linkToken);
  const [status, setStatus] = useState<Status>(linkToken ? 'form' : 'invalid');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the one-time token out of the address bar and browser history once it has been read.
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    if (linkToken) {
      storeToken(linkToken);
      return;
    }
    try {
      const stored = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
      if (stored) {
        setToken(stored);
        setStatus('form');
      }
    } catch {
      // Storage unavailable
    }
  }, [linkToken]);

  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The passwords entered do not match.');
      return;
    }
    const policyError = passwordPolicyError(password);
    if (policyError) {
      setError(policyError);
      return;
    }
    setBusy(true);
    try {
      await fetchApi('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword: password })
      });
      setPassword('');
      setConfirm('');
      storeToken(null);
      setStatus('success');
    } catch (err) {
      if (isApiErrorCode(err, 'INVALID_OR_EXPIRED_TOKEN')) {
        storeToken(null);
        setStatus('invalid');
      } else {
        // Includes the API's WEAK_PASSWORD explanation (for example a password found in a data breach).
        setError(err instanceof Error && err.message ? err.message : 'The password could not be reset. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait" initial={false}>
        {status === 'form' && (
          <motion.form
            key="form"
            onSubmit={submit}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.3, ease: EASE_OUT }}
            className="space-y-4"
          >
            <AnimatePresence initial={false}>
              {error && (
                <motion.div
                  key="error"
                  role="alert"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.3, ease: EASE_OUT }}
                  className="overflow-hidden"
                >
                  <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <Field id="reset-password" label="New Password">
              <PasswordInput
                id="reset-password"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                describedBy="reset-password-policy"
                withIcon
              />
            </Field>
            <Field id="reset-password-confirm" label="Confirm New Password">
              <PasswordInput
                id="reset-password-confirm"
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
                invalid={mismatch}
                withIcon
              />
            </Field>
            {mismatch && <p className="-mt-2 text-[11px] font-semibold text-rose-600">The passwords entered do not match.</p>}
            <PasswordPolicy id="reset-password-policy" password={password} />
            <SubmitButton busy={busy} idle="Set new password" busyLabel="Saving…" />
          </motion.form>
        )}

        {status === 'success' && (
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: EASE_OUT }}
            className="space-y-5"
          >
            <div role="status" className="space-y-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center">
              <CircleCheck className="mx-auto h-8 w-8 text-[#15803D]" aria-hidden="true" />
              <h2 className="text-base font-black text-emerald-950">Your password has been reset</h2>
              <p className="text-sm text-emerald-900">
                For your security, every existing session has been signed out. Please sign in with your new password.
              </p>
            </div>
            <Link href="/portal" className={primaryLink}>
              <span>Sign in to the Team Portal</span>
              <ArrowRight className={arrow} aria-hidden="true" />
            </Link>
          </motion.div>
        )}

        {status === 'invalid' && (
          <motion.div
            key="invalid"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: EASE_OUT }}
            className="space-y-5"
          >
            <div role="alert" className="space-y-2 rounded-2xl border border-rose-200 bg-rose-50 p-5 text-center">
              <CircleAlert className="mx-auto h-8 w-8 text-rose-600" aria-hidden="true" />
              <h2 className="text-base font-black text-rose-950">This link cannot be used</h2>
              <p className="text-sm text-rose-900">{INVALID_LINK_MESSAGE}</p>
            </div>
            <Link href="/portal#forgot-password" className={primaryLink}>
              <span>Request a new reset link</span>
              <ArrowRight className={arrow} aria-hidden="true" />
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
