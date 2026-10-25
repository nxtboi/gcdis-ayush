'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Mail, RefreshCw, Send } from 'lucide-react';
import { adminFetch, isSessionExpiredError } from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from './Modal';
import { LoadingAnnouncement, Notice } from './motion';
import { CARD_CLASS, SectionHeading } from './ContentUi';

/** GET /mail/status (secret-free). */
export interface MailStatus {
  mode: 'smtp' | 'dev-outbox' | 'test-memory' | 'unavailable';
  configured: boolean;
  production: boolean;
  provider: string | null;
  host: string | null;
  port: number | null;
  tls: 'implicit' | 'starttls-required' | 'starttls-opportunistic' | null;
  authUser: string | null;
  passwordSet: boolean;
  from: string;
  outboxDir: string | null;
  warnings: string[];
}

/** POST /mail/test. */
export interface MailTestResult {
  ok: boolean;
  mode: MailStatus['mode'];
  configured: boolean;
  recipient: string;
  durationMs: number;
  message: string;
  response?: string;
  error?: { code: string | null; responseCode: number | null; command: string | null; message: string; hint: string | null };
}

const TLS_LABELS: Record<string, string> = {
  implicit: 'Implicit TLS (SSL)',
  'starttls-required': 'STARTTLS (required)',
  'starttls-opportunistic': 'STARTTLS (when offered)'
};

/** Formal description of the delivery mode. */
export function mailModeLabel(status: Pick<MailStatus, 'mode'>): string {
  switch (status.mode) {
    case 'smtp':
      return 'Configured (SMTP)';
    case 'dev-outbox':
      return 'Not configured: development outbox';
    case 'unavailable':
      return 'Not configured';
    default:
      return 'Test mode';
  }
}

/**
 * Outgoing email settings (Super Administrators): shows whether SMTP is configured, without any
 * credentials, and sends a test message to the signed-in staff member's own address.
 */
export default function MailDiagnostics({ email }: { email?: string | null }) {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<MailTestResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await adminFetch<MailStatus>('/mail/status'));
      setLoadError(null);
    } catch (err) {
      if (!isSessionExpiredError(err)) setLoadError(`The email settings could not be loaded. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sendTest = async () => {
    setSending(true);
    setResult(null);
    setSendError(null);
    try {
      setResult(await adminFetch<MailTestResult>('/mail/test', { method: 'POST' }));
    } catch (err) {
      if (!isSessionExpiredError(err)) setSendError(`The test email could not be requested. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setSending(false);
    }
  };

  const rows: [string, string][] = status
    ? [
        ['Status', mailModeLabel(status)],
        ['Provider', status.provider ?? (status.host ? 'Other SMTP server' : '—')],
        ['Server', status.host ? `${status.host}:${status.port}` : '—'],
        ['Encryption', status.tls ? TLS_LABELS[status.tls] ?? status.tls : '—'],
        ['User', status.authUser ?? '—'],
        ['Password', status.host ? (status.passwordSet ? 'Set (hidden)' : 'Not set') : '—'],
        ['Sender (MAIL_FROM)', status.from],
        ...(status.outboxDir ? ([['Outbox folder', status.outboxDir]] as [string, string][]) : [])
      ]
    : [];

  return (
    <section className={CARD_CLASS} aria-labelledby="mail-settings-heading" aria-busy={loading}>
      <SectionHeading
        id="mail-settings-heading"
        title="Outgoing Email"
        icon={Mail}
        description="Verification and password reset emails. Settings are read from the API environment (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE, MAIL_FROM); credentials are never shown."
        actions={
          <>
            <button type="button" onClick={() => void load()} disabled={loading} className={`${BUTTON_SECONDARY} flex items-center gap-2`}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void sendTest()}
              disabled={sending || loading}
              className={`${BUTTON_PRIMARY} flex items-center gap-2`}
            >
              <Send className="w-3.5 h-3.5" aria-hidden="true" />
              {sending ? 'Sending…' : 'Send Test Email'}
            </button>
          </>
        }
      />
      {loading && <LoadingAnnouncement label="Loading email settings." />}
      <Notice tone="error" message={loadError} onDismiss={() => setLoadError(null)} />
      {status && (
        <>
          <div
            data-testid="mail-status"
            className={`text-xs font-bold ${status.configured ? 'text-emerald-300' : 'text-amber-300'}`}
          >
            {status.configured
              ? 'SMTP is configured. Emails are delivered to real inboxes.'
              : 'SMTP is not configured. Verification and password reset emails are not delivered to real inboxes.'}
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-[11px]">
            {rows.map(([label, value]) => (
              <div key={label} className="flex gap-2 min-w-0">
                <dt className="text-slate-400 shrink-0">{label}:</dt>
                <dd className="text-slate-200 font-mono break-all">{value}</dd>
              </div>
            ))}
          </dl>
          {status.warnings.length > 0 && (
            <ul className="list-disc pl-5 space-y-1 text-[11px] text-amber-200/90">
              {status.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-slate-400">
            The test email is sent to your own address{email ? ` (${email})` : ''}. Changing the settings requires editing the
            API environment and restarting the API.
          </p>
        </>
      )}
      <Notice tone="error" message={sendError} onDismiss={() => setSendError(null)} />
      <div role="status" aria-live="polite">
        {result && (
          <div
            data-testid="mail-test-result"
            className={`p-4 border rounded-xl text-xs space-y-1.5 ${
              result.ok ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200' : 'bg-rose-500/10 border-rose-500/40 text-rose-200'
            }`}
          >
            <div className="font-bold">{result.message}</div>
            {result.response && <div className="font-mono text-[11px] break-all">Server response: {result.response}</div>}
            {result.error && (
              <>
                <div className="font-mono text-[11px] break-all">
                  Error{result.error.code ? ` ${result.error.code}` : ''}
                  {result.error.responseCode ? ` (${result.error.responseCode})` : ''}: {result.error.message}
                </div>
                {result.error.hint && <div className="text-[11px]">{result.error.hint}</div>}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
