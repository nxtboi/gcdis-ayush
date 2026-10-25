'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, ArrowLeft, Mail, MailCheck } from 'lucide-react';
import { fetchApi } from '@/lib/api-client';
import { Field, SubmitButton, inputBase } from './AuthFields';

const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** Generic confirmation: the API never reveals whether an account exists for the address. */
export const RESET_LINK_SENT_MESSAGE = 'If an account exists for this address, a reset link has been sent.';

/** "Reset your password" request form (POST /auth/forgot-password). */
export default function ForgotPasswordForm({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Development servers without SMTP: false (the link is only written to the API outbox). */
  const [deliveryConfigured, setDeliveryConfigured] = useState<boolean | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await fetchApi('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() })
      });
      setSent(true);
      if (process.env.NODE_ENV !== 'production') {
        fetchApi<{ deliveryConfigured?: boolean }>('/auth/email-delivery')
          .then((res) => setDeliveryConfigured(res?.deliveryConfigured === false ? false : true))
          .catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The request could not be completed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <AnimatePresence mode="wait" initial={false}>
        {sent ? (
          <motion.div
            key="sent"
            role="status"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE_OUT }}
            className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
          >
            <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#15803D]" aria-hidden="true" />
            <div className="space-y-1">
              <p className="font-bold">{RESET_LINK_SENT_MESSAGE}</p>
              <p className="text-xs text-emerald-800">
                The link is valid for 30 minutes and may be used once. If no email arrives, please check the spam folder
                or request a new link.
              </p>
              {process.env.NODE_ENV !== 'production' && deliveryConfigured === false && (
                <p data-testid="email-delivery-not-configured" className="text-xs font-semibold text-sky-900">
                  Development server: email delivery is not configured, so no email is sent. The reset link is written to the
                  API outbox folder (apps/api/.mail-outbox) and the API log.
                </p>
              )}
            </div>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            onSubmit={submit}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
            className="space-y-4"
          >
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}
            <Field id="forgot-email" label="Captain Email Address">
              <div className="relative">
                <Mail
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  id="forgot-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={`${inputBase} pl-9 pr-3`}
                  placeholder="captain@institution.ac.in"
                />
              </div>
            </Field>
            <SubmitButton busy={busy} idle="Send reset link" busyLabel="Sending…" />
          </motion.form>
        )}
      </AnimatePresence>

      <p className="text-center text-xs text-slate-500">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 font-bold text-[#15803D] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#22C55E]"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Return to sign in
        </button>
      </p>
    </div>
  );
}
