'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { MailCheck, RefreshCw, Search, Send } from 'lucide-react';
import { adminFetch, isSessionExpiredError, isStepUpCancelledError, toPagedResult } from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, Modal } from './Modal';
import { LoadingAnnouncement, MotionTr, Notice, SkeletonRows, staggerProps } from './motion';
import { formatDateTime } from './types';
import { notifyPendingVerificationsChanged } from './PendingVerificationBadge';

/** A team captain account as returned by GET /auth/users?scope=captains. */
export interface CaptainAccount {
  id: string;
  email: string;
  fullName?: string | null;
  role?: string;
  isActive?: boolean;
  emailVerified?: boolean;
  emailVerifiedAt?: string | null;
  authProvider?: string | null;
  createdAt?: string;
  /** Teams led by the captain (captain listings only). */
  teams?: { id: string; name: string; code: string; registrationCount: number }[];
}

export const CAPTAIN_PAGE_SIZE = 20;
export const VERIFY_REASON_MAX = 300;

const FIELD = 'bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-white w-full text-xs focus:outline-none focus:border-[#22C55E]';
const ROW_BUTTON =
  'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed';

/** True when the account's email address is verified, whichever field the API returned. */
export function isEmailVerified(user: Pick<CaptainAccount, 'emailVerified' | 'emailVerifiedAt'>): boolean {
  return user.emailVerified ?? Boolean(user.emailVerifiedAt);
}

/** Query string for GET /auth/users (team captains, newest first). */
export function captainQuery(page: number, search: string, unverifiedOnly = false): string {
  const params = new URLSearchParams({
    scope: 'captains',
    withMeta: 'true',
    limit: String(CAPTAIN_PAGE_SIZE),
    offset: String((Math.max(1, page) - 1) * CAPTAIN_PAGE_SIZE)
  });
  const term = search.trim();
  if (term) params.set('search', term.slice(0, 254));
  if (unverifiedOnly) params.set('verified', 'false');
  return params.toString();
}

/**
 * Team captain accounts with their email verification status (Super Administrators). A new verification
 * code can be sent, or the address marked as verified (identity confirmation required, audited).
 */
export default function CaptainAccounts() {
  const [items, setItems] = useState<CaptainAccount[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [unverifiedOnly, setUnverifiedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [verifyTarget, setVerifyTarget] = useState<CaptainAccount | null>(null);
  const searchId = useId();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = toPagedResult<CaptainAccount>(await adminFetch(`/auth/users?${captainQuery(page, search, unverifiedOnly)}`));
      setItems(result.items.filter((u) => !u.role || u.role === 'TEAM_CAPTAIN'));
      setTotal(result.total);
      setError(null);
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`The team captain accounts could not be loaded. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setLoading(false);
    }
  }, [page, search, unverifiedOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (updated: CaptainAccount) => setItems((prev) => prev.map((u) => (u.id === updated.id ? { ...u, ...updated } : u)));

  const resend = async (user: CaptainAccount) => {
    setResendingId(user.id);
    setSuccess(null);
    setError(null);
    try {
      await adminFetch(`/auth/users/${encodeURIComponent(user.id)}/resend-verification`, { method: 'POST' });
      setSuccess(`A new verification code has been sent to ${user.email}.`);
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`A new verification code could not be sent. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setResendingId(null);
    }
  };

  const totalPages = total !== null ? Math.max(1, Math.ceil(total / CAPTAIN_PAGE_SIZE)) : null;
  const hasNext = totalPages !== null ? page < totalPages : items.length === CAPTAIN_PAGE_SIZE;

  return (
    <section className="bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-4" aria-labelledby="captain-accounts-heading" aria-busy={loading}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="captain-accounts-heading" className="text-base font-black text-white tracking-tight">
            Team Captain Accounts and Email Verification
          </h2>
          <p className="text-[11px] text-slate-400 max-w-2xl">
            A captain cannot submit a registration or pay the entry fee until the email address is verified. You may send a new
            verification code (pending codes can be revealed under Registrations), or mark the address as verified once it has been confirmed by other means; marking requires
            confirmation with an authentication code and is recorded in the audit log.
          </p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className={`${BUTTON_SECONDARY} flex items-center gap-2`}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setSearch(searchInput.trim());
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="flex-1 min-w-[220px]">
          <label htmlFor={searchId} className="block text-xs font-bold text-slate-300 mb-1">
            Search by email address or name
          </label>
          <input
            id={searchId}
            type="search"
            value={searchInput}
            maxLength={254}
            onChange={(e) => setSearchInput(e.target.value)}
            className={FIELD}
            autoComplete="off"
          />
        </div>
        <button type="submit" className={`${BUTTON_SECONDARY} flex items-center gap-2`}>
          <Search className="w-3.5 h-3.5" aria-hidden="true" />
          Search
        </button>
        <label className="flex items-center gap-2 text-xs text-slate-300 pb-2">
          <input
            type="checkbox"
            checked={unverifiedOnly}
            onChange={(e) => {
              setPage(1);
              setUnverifiedOnly(e.target.checked);
            }}
            className="accent-[#22C55E]"
          />
          Not verified only
        </label>
      </form>

      <Notice tone="success" message={success} onDismiss={() => setSuccess(null)} />
      <Notice tone="error" message={error} onDismiss={() => setError(null)} />
      {loading && <LoadingAnnouncement label="Loading team captain accounts." />}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs font-mono">
          <caption className="sr-only">Team captain accounts and their email verification status</caption>
          <thead>
            <tr className="border-b border-slate-800 text-slate-400 text-[10px] uppercase">
              <th scope="col" className="py-2 px-3">Name</th>
              <th scope="col" className="py-2 px-3">Email Address</th>
              <th scope="col" className="py-2 px-3">Email Verification</th>
              <th scope="col" className="py-2 px-3">Account</th>
              <th scope="col" className="py-2 px-3">Created</th>
              <th scope="col" className="py-2 px-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className={`divide-y divide-slate-800/60 text-[11px] transition-opacity ${loading && items.length > 0 ? 'opacity-60' : ''}`}>
            {loading && items.length === 0 && <SkeletonRows columns={6} rows={4} />}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 px-3 text-center text-slate-400">
                  {search ? 'No team captain account matches the search.' : 'No team captain accounts are registered.'}
                </td>
              </tr>
            )}
            {items.map((u, index) => {
              const verified = isEmailVerified(u);
              const active = u.isActive !== false;
              return (
                <MotionTr key={u.id} {...staggerProps(index)} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-2 px-3 font-bold text-white">
                    {u.fullName || '—'}
                    {u.teams && u.teams.length > 0 && (
                      <span className="block text-[10px] font-normal text-slate-400">
                        {u.teams
                          .map((t) => `${t.name}${t.registrationCount > 0 ? '' : ' (no registration)'}`)
                          .join(', ')}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-slate-300 break-all">{u.email}</td>
                  <td className={`py-2 px-3 ${verified ? 'text-emerald-300' : 'text-amber-300'}`} data-testid="verification-status">
                    {verified ? (
                      <>
                        Verified
                        {u.emailVerifiedAt && <span className="block text-[10px] text-slate-400">{formatDateTime(u.emailVerifiedAt)}</span>}
                      </>
                    ) : (
                      'Not Verified'
                    )}
                  </td>
                  <td className={`py-2 px-3 ${active ? 'text-slate-300' : 'text-rose-300'}`}>{active ? 'Active' : 'Deactivated'}</td>
                  <td className="py-2 px-3 text-slate-400 whitespace-nowrap">{formatDateTime(u.createdAt)}</td>
                  <td className="py-2 px-3 text-right">
                    {!verified && active ? (
                      <div className="inline-flex flex-wrap justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => void resend(u)}
                          disabled={resendingId !== null}
                          aria-label={`Send a new verification code to ${u.email}`}
                          className={`${ROW_BUTTON} text-slate-200 border-slate-600 hover:bg-slate-800`}
                        >
                          <Send className="w-3 h-3" aria-hidden="true" />
                          {resendingId === u.id ? 'Sending…' : 'Resend Code'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSuccess(null);
                            setVerifyTarget(u);
                          }}
                          aria-label={`Mark the email address of ${u.email} as verified`}
                          className={`${ROW_BUTTON} text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/10`}
                        >
                          <MailCheck className="w-3 h-3" aria-hidden="true" />
                          Mark Verified
                        </button>
                      </div>
                    ) : (
                      <span className="text-slate-400">{verified ? 'No action needed' : 'Reactivate first'}</span>
                    )}
                  </td>
                </MotionTr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-slate-400">
        <span>
          Page {page}
          {totalPages !== null ? ` of ${totalPages}` : ''}
          {total !== null ? ` (${total} ${total === 1 ? 'account' : 'accounts'})` : ''}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={loading || page <= 1} className={BUTTON_SECONDARY}>
            Previous
          </button>
          <button type="button" onClick={() => setPage((p) => p + 1)} disabled={loading || !hasNext} className={BUTTON_SECONDARY}>
            Next
          </button>
        </div>
      </div>

      <MarkVerifiedDialog
        user={verifyTarget}
        onClose={() => setVerifyTarget(null)}
        onVerified={(updated, message) => {
          setVerifyTarget(null);
          replace(updated);
          setSuccess(message);
        }}
      />
    </section>
  );
}

/** Confirmation with an optional reason (recorded in the audit log); the API asks for step-up. */
export function MarkVerifiedDialog({
  user,
  onClose,
  onVerified
}: {
  user: CaptainAccount | null;
  onClose: () => void;
  onVerified: (user: CaptainAccount, message: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();

  useEffect(() => {
    if (user) {
      setReason('');
      setError(null);
      setBusy(false);
    }
  }, [user]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!user) return;
    setBusy(true);
    setError(null);
    const trimmed = reason.trim();
    try {
      const updated = await adminFetch<CaptainAccount>(`/auth/users/${encodeURIComponent(user.id)}/mark-email-verified`, {
        method: 'POST',
        body: JSON.stringify(trimmed ? { reason: trimmed } : {})
      });
      notifyPendingVerificationsChanged();
      onVerified(
        { ...user, ...(updated ?? {}), emailVerified: true },
        `The email address ${user.email} has been marked as verified.`
      );
    } catch (err) {
      if (isSessionExpiredError(err)) return;
      setError(isStepUpCancelledError(err) ? err.message : `The email address could not be marked as verified. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={user !== null}
      title="Mark Email Address as Verified"
      description={user ? `${user.fullName || 'Team captain'} (${user.email})` : undefined}
      onClose={onClose}
      busy={busy}
      size="sm"
    >
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-slate-300 leading-relaxed">
          Only mark the address as verified once you have confirmed that the captain controls it (for example by telephone or in
          person). The captain will then be able to submit the registration and pay the entry fee. Outstanding verification codes
          stop working. You will be asked to confirm your identity with an authentication code.
        </p>
        <div>
          <label htmlFor={reasonId} className="block text-xs font-bold text-slate-300 mb-1">
            Reason <span className="font-normal text-slate-400">(optional, recorded in the audit log)</span>
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, VERIFY_REASON_MAX))}
            maxLength={VERIFY_REASON_MAX}
            rows={3}
            disabled={busy}
            className={`${FIELD} resize-none`}
            data-autofocus
          />
          <div className="text-[10px] text-slate-400 text-right mt-1">
            {reason.length} of {VERIFY_REASON_MAX} characters
          </div>
        </div>
        <Notice tone="error" message={error} onDismiss={() => setError(null)} />
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={busy} className={BUTTON_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={BUTTON_PRIMARY}>
            {busy ? 'Please Wait…' : 'Mark as Verified'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
