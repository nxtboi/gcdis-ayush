'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, MailCheck, MailWarning, RefreshCw, Send } from 'lucide-react';
import { adminFetch, isSessionExpiredError, isStepUpCancelledError, toPagedResult } from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import { BUTTON_SECONDARY } from './Modal';
import { LoadingAnnouncement, MotionTr, Notice, staggerProps } from './motion';
import { MarkVerifiedDialog, type CaptainAccount } from './CaptainAccounts';
import { notifyPendingVerificationsChanged } from './PendingVerificationBadge';
import { formatDateTime } from './types';

/** Metadata of a captain's pending verification code (the code itself is only returned by "Reveal"). */
export interface PendingCode {
  sentAt: string;
  expiresAt: string;
  attemptsRemaining: number;
}

/** A captain awaiting verification (GET /auth/captains/awaiting-verification). */
export interface AwaitingCaptain extends CaptainAccount {
  pendingCode?: PendingCode | null;
}

export const AWAITING_PAGE_SIZE = 25;
/** A revealed code is hidden again after this long. */
export const REVEAL_VISIBLE_MS = 60_000;
export const MASKED_CODE = '••••••';

const ROW_BUTTON =
  'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

/** Roles allowed to reveal codes, resend and mark addresses verified (enforced again by the API). */
export function canManageVerifications(role?: string | null): boolean {
  return role === 'SUPER_ADMIN' || role === 'EVENT_ADMIN';
}

/**
 * "Pending Email Verifications" (Registrations tab): team captains who cannot submit a registration or pay
 * because their address is not verified, with their teams and the pending six-digit code. Administrators
 * can reveal a code (identity confirmation required, audited) to pass it on by telephone while email
 * delivery is unavailable, send a new code, or mark the address as verified.
 */
export default function AwaitingVerificationPanel() {
  const [items, setItems] = useState<AwaitingCaptain[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, { code: string; until: number }>>({});
  const [verifyTarget, setVerifyTarget] = useState<AwaitingCaptain | null>(null);
  const canManage = canManageVerifications(role);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [me, data] = await Promise.all([
        adminFetch<{ user?: { role?: string } | null }>('/auth/me').catch(() => null),
        adminFetch(`/auth/captains/awaiting-verification?limit=${AWAITING_PAGE_SIZE}&offset=0`)
      ]);
      if (me?.user?.role) setRole(me.user.role);
      const result = toPagedResult<AwaitingCaptain>(data);
      setItems(result.items);
      setTotal(result.total);
      setError(null);
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`The pending email verifications could not be loaded. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Hide revealed codes again after REVEAL_VISIBLE_MS
  useEffect(() => {
    const entries = Object.entries(revealed);
    if (entries.length === 0) return;
    const next = Math.min(...entries.map(([, v]) => v.until));
    const id = window.setTimeout(() => {
      const now = Date.now();
      setRevealed((prev) => Object.fromEntries(Object.entries(prev).filter(([, v]) => v.until > now)));
    }, Math.max(0, next - Date.now()) + 50);
    return () => window.clearTimeout(id);
  }, [revealed]);

  const reveal = async (user: AwaitingCaptain) => {
    setBusyId(user.id);
    setError(null);
    setSuccess(null);
    try {
      const res = await adminFetch<{ code: string; expiresAt: string }>(
        `/auth/users/${encodeURIComponent(user.id)}/reveal-verification-code`,
        { method: 'POST' }
      );
      if (res?.code) setRevealed((prev) => ({ ...prev, [user.id]: { code: res.code, until: Date.now() + REVEAL_VISIBLE_MS } }));
    } catch (err) {
      if (isSessionExpiredError(err)) return;
      setError(isStepUpCancelledError(err) ? err.message : `The code could not be revealed. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setBusyId(null);
    }
  };

  const hide = (id: string) =>
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const resend = async (user: AwaitingCaptain) => {
    setBusyId(user.id);
    setSuccess(null);
    setError(null);
    try {
      await adminFetch(`/auth/users/${encodeURIComponent(user.id)}/resend-verification`, { method: 'POST' });
      hide(user.id);
      setSuccess(`A new verification code has been sent to ${user.email}. The previous code no longer works.`);
      await load();
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`A new code could not be sent. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      className="bg-[#111625] border border-amber-500/30 rounded-2xl p-6 space-y-4"
      aria-labelledby="awaiting-verification-heading"
      aria-busy={loading}
      data-testid="pending-email-verifications"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="awaiting-verification-heading" className="text-base font-black text-white tracking-tight flex items-center gap-2">
            <MailWarning className="w-4 h-4 text-amber-300" aria-hidden="true" />
            Pending Email Verifications{total !== null ? ` (${total})` : ''}
          </h2>
          <p className="text-[11px] text-slate-400 max-w-3xl">
            These team captains have not verified their email address, so they cannot submit a registration or pay the entry fee,
            and their teams do not yet appear in the registrations below.
            {canManage
              ? ' Until email delivery works you may reveal the current six-digit code and pass it on by telephone or WhatsApp to the captain only, send a new code, or mark the address as verified. Revealing a code and marking an address verified require confirmation with an authentication code and are recorded in the audit log.'
              : ' An administrator can reveal the pending code, send a new code or mark the address as verified.'}
          </p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className={`${BUTTON_SECONDARY} flex items-center gap-2`}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
          Refresh
        </button>
      </div>
      <Notice tone="success" message={success} onDismiss={() => setSuccess(null)} />
      <Notice tone="error" message={error} onDismiss={() => setError(null)} />
      {loading && <LoadingAnnouncement label="Loading pending email verifications." />}
      {!loading && items.length === 0 && !error && (
        <p className="text-xs text-slate-400">Every team captain has verified the email address. No verification is pending.</p>
      )}
      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <caption className="sr-only">Team captains whose email address is not verified</caption>
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-[10px] uppercase">
                <th scope="col" className="py-2 px-3">Captain</th>
                <th scope="col" className="py-2 px-3">Email Address</th>
                <th scope="col" className="py-2 px-3">Team</th>
                <th scope="col" className="py-2 px-3">Code Sent</th>
                <th scope="col" className="py-2 px-3">Expires</th>
                <th scope="col" className="py-2 px-3">Current Code</th>
                {canManage && (
                  <th scope="col" className="py-2 px-3 text-right">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-[11px]">
              {items.map((u, index) => {
                const pending = u.pendingCode ?? null;
                const shown = revealed[u.id];
                const rowBusy = busyId === u.id;
                return (
                  <MotionTr key={u.id} {...staggerProps(index)} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-2 px-3 font-bold text-white">{u.fullName || '—'}</td>
                    <td className="py-2 px-3 text-slate-300 break-all">{u.email}</td>
                    <td className="py-2 px-3 text-slate-300">
                      {u.teams && u.teams.length > 0 ? (
                        u.teams.map((t) => (
                          <div key={t.id}>
                            <span className="text-white">{t.name}</span> <span className="text-slate-400">{t.code}</span>
                            <span className="block text-[10px] text-amber-300">
                              {t.registrationCount > 0 ? 'Registration submitted' : 'No registration (blocked until verified)'}
                            </span>
                          </div>
                        ))
                      ) : (
                        <span className="text-slate-400">No team yet</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-slate-300 whitespace-nowrap">{pending ? formatDateTime(pending.sentAt) : '—'}</td>
                    <td className="py-2 px-3 text-slate-300 whitespace-nowrap">
                      {pending ? (
                        <>
                          {formatDateTime(pending.expiresAt)}
                          <span className="block text-[10px] text-slate-400">
                            {pending.attemptsRemaining} {pending.attemptsRemaining === 1 ? 'attempt' : 'attempts'} left
                          </span>
                        </>
                      ) : (
                        <span className="text-amber-300">No valid code</span>
                      )}
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap">
                      {pending ? (
                        <div className="flex items-center gap-2">
                          <span
                            data-testid="verification-code"
                            className={`font-black tracking-[0.3em] ${shown ? 'text-emerald-300 text-sm select-all' : 'text-slate-400'}`}
                            aria-label={shown ? `Verification code ${shown.code.split('').join(' ')}` : 'Verification code hidden'}
                          >
                            {shown ? shown.code : MASKED_CODE}
                          </span>
                          {canManage &&
                            (shown ? (
                              <button
                                type="button"
                                onClick={() => hide(u.id)}
                                className={`${ROW_BUTTON} text-slate-300 border-slate-600 hover:bg-slate-800`}
                                aria-label={`Hide the verification code of ${u.email}`}
                              >
                                <EyeOff className="w-3 h-3" aria-hidden="true" />
                                Hide
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => void reveal(u)}
                                disabled={busyId !== null}
                                className={`${ROW_BUTTON} text-amber-200 border-amber-500/40 hover:bg-amber-500/10`}
                                aria-label={`Reveal the verification code of ${u.email}`}
                              >
                                <Eye className="w-3 h-3" aria-hidden="true" />
                                {rowBusy ? 'Please Wait…' : 'Reveal'}
                              </button>
                            ))}
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    {canManage && (
                      <td className="py-2 px-3 text-right">
                        <div className="inline-flex flex-wrap justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => void resend(u)}
                            disabled={busyId !== null}
                            aria-label={`Send a new verification code to ${u.email}`}
                            className={`${ROW_BUTTON} text-slate-200 border-slate-600 hover:bg-slate-800`}
                          >
                            <Send className="w-3 h-3" aria-hidden="true" />
                            Resend Code
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSuccess(null);
                              setVerifyTarget(u);
                            }}
                            disabled={busyId !== null}
                            aria-label={`Mark the email address of ${u.email} as verified`}
                            className={`${ROW_BUTTON} text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/10`}
                          >
                            <MailCheck className="w-3 h-3" aria-hidden="true" />
                            Mark Verified
                          </button>
                        </div>
                      </td>
                    )}
                  </MotionTr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {total !== null && total > items.length && (
        <p className="text-[11px] text-slate-400">
          Showing the {items.length} most recent of {total}. The full list of captain accounts, with search, is under Users and Roles.
        </p>
      )}
      {canManage && (
        <MarkVerifiedDialog
          user={verifyTarget}
          onClose={() => setVerifyTarget(null)}
          onVerified={(updated, message) => {
            setVerifyTarget(null);
            hide(updated.id);
            setItems((prev) => prev.filter((u) => u.id !== updated.id));
            setTotal((t) => (t !== null ? Math.max(0, t - 1) : t));
            setSuccess(`${message} The captain can now submit the registration.`);
            notifyPendingVerificationsChanged();
          }}
        />
      )}
    </section>
  );
}
