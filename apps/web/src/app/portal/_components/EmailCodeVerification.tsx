'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Info, Loader2, RotateCw, ShieldCheck } from 'lucide-react';
import { fetchApi, isApiErrorCode } from '@/lib/api-client';
import { announceEmailVerified } from '@/lib/email-verification-sync';

export const CODE_LENGTH = 6;
/** id of the first digit box: other parts of the dashboard focus it ("Enter verification code"). */
export const FIRST_CODE_INPUT_ID = 'email-code-digit-0';

interface VerificationStatus {
  verified: boolean;
  pending: { sentAt: string; expiresAt: string; attemptsRemaining: number } | null;
  resendAvailableAt: string | null;
}

/** Keeps digits only, at most six. */
export function sanitiseCode(value: string): string {
  return String(value || '').replace(/\D/g, '').slice(0, CODE_LENGTH);
}

/** "1:05" */
function formatSeconds(total: number): string {
  const s = Math.max(0, Math.ceil(total));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Moves keyboard focus to the first code box (and scrolls it into view). */
export function focusCodeInput(): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(FIRST_CODE_INPUT_ID) as HTMLInputElement | null;
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.focus({ preventScroll: true });
}

/**
 * "Verify your email" step: six single-digit boxes (paste and one-time-code autofill supported), a
 * "Resend code" button with a cooldown, and formal error messages. Calls onVerified at once on success
 * so gated actions unlock without a reload; other open portal tabs are notified too.
 */
export default function EmailCodeVerification({
  email,
  deliveryConfigured,
  onVerified,
  autoFocus = true
}: {
  email: string;
  /** GET /auth/email-delivery: false only on a development API without SMTP. */
  deliveryConfigured: boolean | null;
  onVerified: () => void;
  autoFocus?: boolean;
}) {
  const [digits, setDigits] = useState<string[]>(() => Array(CODE_LENGTH).fill(''));
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const submitting = useRef(false);
  const devOutbox = process.env.NODE_ENV !== 'production' && deliveryConfigured === false;
  // Latest callback without re-running effects when the parent passes a new function each render
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;
  const verified = useCallback(() => onVerifiedRef.current(), []);

  const loadStatus = useCallback(async () => {
    try {
      const status = await fetchApi<VerificationStatus>('/auth/verification-status');
      if (status?.verified) {
        verified();
        return;
      }
      setExpiresAt(status?.pending ? Date.parse(status.pending.expiresAt) : null);
      setResendAt(status?.resendAvailableAt ? Date.parse(status.resendAvailableAt) : null);
    } catch {
      // The step still works; the cooldown is enforced by the API
    }
  }, [verified]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (autoFocus) inputs.current[0]?.focus({ preventScroll: true });
  }, [autoFocus]);

  // One tick per second while a countdown is visible
  const ticking = (resendAt !== null && resendAt > now) || (expiresAt !== null && expiresAt > now);
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  const clear = () => {
    setDigits(Array(CODE_LENGTH).fill(''));
    window.setTimeout(() => inputs.current[0]?.focus(), 0);
  };

  const submit = async (code: string) => {
    if (submitting.current) return;
    if (code.length !== CODE_LENGTH) {
      setError('Please enter all six digits of the verification code.');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fetchApi('/auth/verify-email-code', { method: 'POST', body: JSON.stringify({ code }) });
      announceEmailVerified();
      verified();
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'The code could not be checked. Please try again.';
      if (isApiErrorCode(err, 'CODE_LOCKED') || isApiErrorCode(err, 'CODE_EXPIRED')) {
        setExpiresAt(null);
        setError(`${message.replace(/\s*Please request a new code\.?$/, '')} Please use "Resend code" to receive a new code.`);
      } else {
        setError(message);
      }
      clear();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const setFrom = (index: number, value: string) => {
    const clean = sanitiseCode(value);
    if (!clean) {
      setDigits((prev) => prev.map((d, i) => (i === index ? '' : d)));
      return;
    }
    // Several digits at once (paste or one-time-code autofill): fill from this box onwards
    const next = [...digits];
    for (let i = 0; i < clean.length && index + i < CODE_LENGTH; i++) next[index + i] = clean[i];
    setDigits(next);
    setError(null);
    const target = Math.min(index + clean.length, CODE_LENGTH - 1);
    inputs.current[target]?.focus();
    const code = next.join('');
    if (code.length === CODE_LENGTH && !next.includes('')) void submit(code);
  };

  const onKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      event.preventDefault();
      setDigits((prev) => prev.map((d, i) => (i === index - 1 ? '' : d)));
      inputs.current[index - 1]?.focus();
    } else if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      inputs.current[index - 1]?.focus();
    } else if (event.key === 'ArrowRight' && index < CODE_LENGTH - 1) {
      event.preventDefault();
      inputs.current[index + 1]?.focus();
    }
  };

  const resend = async () => {
    setSending(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetchApi<{ alreadyVerified?: boolean; expiresAt?: string; resendAvailableAt?: string }>(
        '/auth/resend-verification',
        { method: 'POST' }
      );
      if (res?.alreadyVerified) {
        verified();
        return;
      }
      setExpiresAt(res?.expiresAt ? Date.parse(res.expiresAt) : Date.now() + 15 * 60_000);
      setResendAt(res?.resendAvailableAt ? Date.parse(res.resendAvailableAt) : Date.now() + 60_000);
      setNow(Date.now());
      setInfo(
        devOutbox
          ? 'A new code has been issued. Email delivery is not configured on this development server: the code is in the API outbox folder (apps/api/.mail-outbox) and the API log.'
          : `A new code has been sent to ${email}. Please also check the spam or junk folder.`
      );
      clear();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'A new code could not be sent. Please try again later.');
      void loadStatus();
    } finally {
      setSending(false);
    }
  };

  const cooldown = resendAt !== null && resendAt > now ? (resendAt - now) / 1000 : 0;
  const expiresIn = expiresAt !== null ? (expiresAt - now) / 1000 : null;
  const code = digits.join('');

  return (
    <div className="space-y-3" data-testid="email-code-verification">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(code);
        }}
        className="flex flex-wrap items-center gap-3"
        aria-describedby="email-code-help"
      >
        <fieldset className="flex gap-1.5 sm:gap-2" disabled={busy}>
          <legend className="sr-only">Six-digit verification code</legend>
          {digits.map((digit, i) => (
            <input
              key={i}
              id={i === 0 ? FIRST_CODE_INPUT_ID : undefined}
              ref={(el) => {
                inputs.current[i] = el;
              }}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              // The first box accepts a whole autofilled or pasted code
              maxLength={i === 0 ? CODE_LENGTH : 1}
              value={digit}
              aria-label={`Digit ${i + 1} of ${CODE_LENGTH}`}
              aria-invalid={error ? true : undefined}
              onChange={(e) => setFrom(i, e.target.value)}
              onKeyDown={(e) => onKeyDown(i, e)}
              onPaste={(e) => {
                e.preventDefault();
                setFrom(i, e.clipboardData.getData('text'));
              }}
              onFocus={(e) => e.target.select()}
              className="h-11 w-9 sm:h-12 sm:w-10 rounded-xl border border-slate-300 bg-white text-center font-mono text-lg font-black text-slate-900 transition-[border-color,box-shadow] focus:border-[#15803D] focus:outline-none focus:ring-4 focus:ring-[#22C55E]/20 disabled:opacity-60"
            />
          ))}
        </fieldset>
        <button
          type="submit"
          disabled={busy || code.length !== CODE_LENGTH}
          className="inline-flex items-center gap-2 rounded-full bg-[#15803D] px-4 py-2 text-[11px] font-black uppercase tracking-wider text-white transition-colors enabled:hover:bg-[#166534] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{busy ? 'Checking…' : 'Verify'}</span>
        </button>
        <button
          type="button"
          onClick={() => void resend()}
          disabled={sending || cooldown > 0}
          className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-800 transition-colors enabled:hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {sending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{sending ? 'Sending…' : cooldown > 0 ? `Resend code (${formatSeconds(cooldown)})` : 'Resend code'}</span>
        </button>
      </form>
      <p id="email-code-help" className="text-[11px] text-slate-600">
        Enter the six-digit code sent to <span className="font-bold">{email}</span>.{' '}
        {expiresIn === null
          ? 'Codes are valid for 15 minutes.'
          : expiresIn > 0
            ? `The current code expires in ${formatSeconds(expiresIn)}.`
            : 'The current code has expired; please request a new one.'}
      </p>
      {devOutbox && (
        <p
          data-testid="email-delivery-not-configured"
          className="flex items-start gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-2 text-[11px] leading-relaxed text-sky-900"
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-bold">Development server: email delivery is not configured.</span> No email is sent; the
            code is written to the API outbox folder (apps/api/.mail-outbox) and the API log. Staff can also read a pending
            code in the console.
          </span>
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs font-semibold text-rose-700">
          {error}
        </p>
      )}
      {info && (
        <p role="status" className="text-xs font-semibold text-[#15803D]">
          {info}
        </p>
      )}
    </div>
  );
}
