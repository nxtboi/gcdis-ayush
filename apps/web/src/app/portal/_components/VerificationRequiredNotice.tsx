'use client';

import React from 'react';
import { KeyRound, MailWarning } from 'lucide-react';
import { focusCodeInput } from './EmailCodeVerification';

/** Passed to the places where an unverified captain tries to register or pay (null once verified). */
export interface EmailVerificationGate {
  email: string;
  /** GET /auth/email-delivery: false only on a development API without SMTP. */
  deliveryConfigured: boolean | null;
  /** Called when the address has been verified. */
  onVerified: () => void;
}

/**
 * Inline blocker shown exactly where a captain submits the registration or pays the entry fee while the
 * email address is unverified. It explains the requirement and takes the captain to the "Verify your
 * email" code step at the top of the dashboard (which also offers "Resend code").
 */
export default function VerificationRequiredNotice({
  gate,
  action
}: {
  gate: EmailVerificationGate;
  /** What is blocked, e.g. "submit the registration" or "pay the entry fee". */
  action: string;
}) {
  const devOutbox = process.env.NODE_ENV !== 'production' && gate.deliveryConfigured === false;
  return (
    <div
      role="note"
      data-testid="verification-required-notice"
      className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-amber-950 space-y-2"
    >
      <div className="flex items-start gap-2">
        <MailWarning className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-xs font-black">Verify your email address first</p>
          <p className="text-[11px] leading-relaxed text-amber-900">
            You can {action} only after the captain email address <span className="font-bold">{gate.email}</span> has been
            verified. Enter the six-digit code from the verification email in the &ldquo;Verify your email&rdquo; panel at the
            top of this page, or request a new code there.
            {devOutbox && ' This development server does not send email: the code is in the API outbox folder (apps/api/.mail-outbox).'}
          </p>
        </div>
      </div>
      <div className="pl-6">
        <button
          type="button"
          onClick={focusCodeInput}
          className="inline-flex items-center gap-2 rounded-full bg-[#111625] px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider text-white transition-colors hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
        >
          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Enter verification code</span>
        </button>
      </div>
    </div>
  );
}
