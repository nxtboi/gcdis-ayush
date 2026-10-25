'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { MailWarning } from 'lucide-react';
import { DURATION, EASE_OUT } from './motion';
import EmailCodeVerification from './EmailCodeVerification';

/** True only in a development build: production never shows the "email delivery not configured" notice. */
export const IS_DEVELOPMENT_BUILD = process.env.NODE_ENV !== 'production';

/**
 * "Verify your email" step at the top of the dashboard while the captain's address is unverified
 * (shown right after sign-up and on every tab). Registration submission and payment are refused by the
 * API (403 EMAIL_NOT_VERIFIED) until the six-digit code has been entered.
 */
export default function EmailVerificationBanner({
  email,
  justRegistered,
  onVerified,
  deliveryConfigured
}: {
  email: string;
  /** True right after registration: the code has just been sent. */
  justRegistered: boolean;
  /** Called as soon as the address is verified (gated actions unlock without a reload). */
  onVerified: () => void;
  /**
   * GET /auth/email-delivery: false only on a development server without SMTP (codes are written to the
   * API's outbox folder instead of being delivered). null while unknown.
   */
  deliveryConfigured: boolean | null;
}) {
  return (
    <motion.section
      aria-labelledby="email-verification-title"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASE_OUT }}
      className="max-w-6xl rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:p-5 text-amber-950 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
          <MailWarning className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1">
            <h2 id="email-verification-title" className="text-sm font-black">
              Verify your email
            </h2>
            <p className="text-xs leading-relaxed text-amber-900">
              {justRegistered && !(IS_DEVELOPMENT_BUILD && deliveryConfigured === false) ? (
                <>
                  A six-digit verification code has been sent to <span className="font-bold">{email}</span>.
                </>
              ) : (
                <>
                  The captain email address <span className="font-bold">{email}</span> has not yet been verified.
                </>
              )}{' '}
              The registration can be submitted and the entry fee paid only after the email address has been verified.
            </p>
          </div>
          <EmailCodeVerification email={email} deliveryConfigured={deliveryConfigured} onVerified={onVerified} />
        </div>
      </div>
    </motion.section>
  );
}
