'use client';

import React, { useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { isSessionExpiredError, setStepUpHandler, submitStepUpCode } from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, Modal } from './Modal';
import { Notice } from './motion';

const FIELD =
  'w-full bg-[#182035] border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white font-mono tracking-widest placeholder-slate-400 focus:outline-none focus:border-[#22C55E]';

/**
 * Identity confirmation for sensitive actions. Registered with the API client: when a request is
 * answered with 403 STEP_UP_REQUIRED, this dialog asks for the authenticator code (or a recovery code),
 * calls POST /auth/step-up and lets the client retry the original request once. Cancelling aborts it.
 */
export default function StepUpDialog() {
  const [open, setOpen] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  useEffect(() => {
    setStepUpHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolverRef.current = resolve;
          setCode('');
          setError(null);
          setUseRecovery(false);
          setOpen(true);
        })
    );
    return () => {
      setStepUpHandler(null);
      resolverRef.current?.(false);
      resolverRef.current = null;
    };
  }, []);

  const finish = (confirmed: boolean) => {
    setOpen(false);
    setBusy(false);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(confirmed);
  };

  const trimmed = code.trim();
  const isValidFormat = useRecovery ? trimmed.length >= 6 : /^\d{6}$/.test(trimmed);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidFormat) {
      setError(useRecovery ? 'Please enter one of your recovery codes.' : 'Please enter the six-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submitStepUpCode(trimmed);
      finish(true);
    } catch (err) {
      if (isSessionExpiredError(err)) {
        finish(false);
        return;
      }
      setBusy(false);
      setCode('');
      setError(errorMessage(err, 'The authentication code or recovery code is not valid. Please try again.'));
    }
  };

  return (
    <Modal
      open={open}
      title="Confirm Your Identity"
      description="This action requires a recent confirmation. Your confirmation remains valid for ten minutes."
      onClose={() => finish(false)}
      busy={busy}
      size="sm"
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="flex items-start gap-3 p-3 rounded-xl bg-sky-500/10 border border-sky-500/30 text-sky-200 text-xs">
          <KeyRound className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            {useRecovery
              ? 'Enter one of the recovery codes issued when two-factor authentication was set up. Each code can be used once.'
              : 'Enter the current six-digit code from your authenticator app.'}
          </span>
        </div>
        <div>
          <label htmlFor="step-up-code" className="block text-xs font-bold text-slate-300 mb-1.5">
            {useRecovery ? 'Recovery Code' : 'Authentication Code'}
          </label>
          <input
            id="step-up-code"
            data-autofocus
            type="text"
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            maxLength={useRecovery ? 32 : 6}
            value={code}
            onChange={(e) => setCode(useRecovery ? e.target.value : e.target.value.replace(/\D/g, ''))}
            placeholder={useRecovery ? 'XXXX-XXXX-XXXX-XXXX' : '000000'}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'step-up-error' : undefined}
            className={FIELD}
          />
        </div>
        <div id="step-up-error">
          <Notice tone="error" message={error} />
        </div>
        <button
          type="button"
          onClick={() => {
            setUseRecovery((prev) => !prev);
            setCode('');
            setError(null);
          }}
          className="text-[11px] text-slate-300 underline hover:text-white transition-colors"
        >
          {useRecovery ? 'Use an authenticator code instead' : 'Use a recovery code instead'}
        </button>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => finish(false)} disabled={busy} className={BUTTON_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={BUTTON_PRIMARY}>
            {busy ? 'Verifying…' : 'Confirm and Continue'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
