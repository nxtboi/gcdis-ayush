'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Fingerprint, KeyRound, LockKeyhole, LogOut, MonitorSmartphone, RefreshCw, ShieldCheck, Timer } from 'lucide-react';
import {
  adminFetch,
  isSessionExpiredError,
  isStepUpCancelledError,
  verifyAuditChain,
  type AuditChainReport
} from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import { passwordPolicyError } from '../../lib/password-policy';
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, ConfirmDialog } from './Modal';
import { LoadingAnnouncement, MotionTr, Notice, SkeletonRows, staggerProps } from './motion';
import { CARD_CLASS, Field, INPUT_CLASS, SectionHeading } from './ContentUi';
import { PasswordPolicyList } from './AuthScreens';
import { summariseUserAgent, type AuthSession } from './contentTypes';
import { formatDateTime, hasTwoFactor, roleLabel, type StaffUser } from './types';
import MailDiagnostics from './MailDiagnostics';

interface SecurityTabProps {
  currentUser: StaffUser | null;
  /** Opens the console's "Sign Out of All Sessions" confirmation. */
  onSignOutAll: () => void;
  /** Called after the current session was revoked here: the console returns to the sign-in screen. */
  onCurrentSessionRevoked: () => void;
  idleTimeoutMinutes: number;
  /** Called after the password was changed: the API has signed out every session, including this one. */
  onPasswordChanged?: () => void;
}

export default function SecurityTab({
  currentUser,
  onSignOutAll,
  onCurrentSessionRevoked,
  idleTimeoutMinutes,
  onPasswordChanged
}: SecurityTabProps) {
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<AuthSession | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await adminFetch<AuthSession[] | { items?: AuthSession[] }>('/auth/sessions');
      const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
      // The current session first, then the most recently used
      list.sort((a, b) => Number(b.current) - Number(a.current) || Date.parse(b.lastUsedAt ?? b.createdAt) - Date.parse(a.lastUsedAt ?? a.createdAt));
      setSessions(list);
      setError(null);
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`The active sessions could not be loaded. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRevoke = async () => {
    if (!pendingRevoke) return;
    const target = pendingRevoke;
    setIsRevoking(true);
    try {
      await adminFetch(`/auth/sessions/${target.id}`, { method: 'DELETE' });
      if (target.current) {
        setPendingRevoke(null);
        onCurrentSessionRevoked();
        return;
      }
      setSessions((prev) => prev.filter((s) => s.id !== target.id));
      setSuccess(`The session on ${summariseUserAgent(target.userAgent)} has been signed out.`);
      setError(null);
    } catch (err) {
      if (!isSessionExpiredError(err)) {
        setSuccess(null);
        setError(isStepUpCancelledError(err) ? err.message : `The session could not be signed out. ${errorMessage(err, 'Please try again.')}`);
      }
    } finally {
      setIsRevoking(false);
      setPendingRevoke(null);
    }
  };

  const twoFactor = currentUser ? hasTwoFactor(currentUser) : false;
  const otherSessions = sessions.filter((s) => !s.current).length;

  return (
    <div className="space-y-6 max-w-5xl">
      <Notice tone="success" message={success} onDismiss={() => setSuccess(null)} />
      <Notice tone="error" message={error} onDismiss={() => setError(null)} />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className={`${CARD_CLASS} !space-y-2`}>
          <div className="flex items-center gap-2 text-xs font-bold text-slate-300">
            <ShieldCheck className="w-4 h-4 text-[#22C55E]" aria-hidden="true" />
            Two-Factor Authentication
          </div>
          <div className={`text-sm font-black ${twoFactor ? 'text-emerald-300' : 'text-amber-300'}`}>{twoFactor ? 'Enabled' : 'Not Enabled'}</div>
          <p className="text-[11px] text-slate-400">
            {twoFactor
              ? 'An authenticator code is required at sign-in and to confirm sensitive actions.'
              : 'Two-factor authentication is required for staff accounts. You will be asked to set it up at your next sign-in.'}
          </p>
        </div>
        <div className={`${CARD_CLASS} !space-y-2`}>
          <div className="flex items-center gap-2 text-xs font-bold text-slate-300">
            <KeyRound className="w-4 h-4 text-[#22C55E]" aria-hidden="true" />
            Account
          </div>
          <div className="text-sm font-black text-white truncate" title={currentUser?.email}>
            {currentUser?.fullName || currentUser?.email || 'Staff Member'}
          </div>
          <p className="text-[11px] text-slate-400">
            {roleLabel(currentUser?.role)}. Deleting content, saving site information and signing out other sessions ask you to confirm your identity again.
          </p>
        </div>
        <div className={`${CARD_CLASS} !space-y-2`}>
          <div className="flex items-center gap-2 text-xs font-bold text-slate-300">
            <Timer className="w-4 h-4 text-[#22C55E]" aria-hidden="true" />
            Inactivity Sign-Out
          </div>
          <div className="text-sm font-black text-white">{idleTimeoutMinutes} Minutes</div>
          <p className="text-[11px] text-slate-400">A countdown is shown two minutes before you are signed out for inactivity.</p>
        </div>
      </div>

      <section className={CARD_CLASS} aria-labelledby="sessions-heading" aria-busy={isLoading}>
        <SectionHeading
          id="sessions-heading"
          title="Active Sessions"
          icon={MonitorSmartphone}
          description="Devices currently signed in to your account. Sign out any session you do not recognise."
          actions={
            <>
              <button type="button" onClick={() => void load()} disabled={isLoading} className={`${BUTTON_SECONDARY} flex items-center gap-2`}>
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
                Refresh
              </button>
              <button type="button" onClick={onSignOutAll} className={`${BUTTON_DANGER} flex items-center gap-2`}>
                <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                Sign Out of All Sessions
              </button>
            </>
          }
        />
        {isLoading && <LoadingAnnouncement label="Loading active sessions." />}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Your active sessions</caption>
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-[10px] uppercase font-mono">
                <th scope="col" className="py-2 px-3">Device</th>
                <th scope="col" className="py-2 px-3">IP Address</th>
                <th scope="col" className="py-2 px-3">Signed In</th>
                <th scope="col" className="py-2 px-3">Last Used</th>
                <th scope="col" className="py-2 px-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-[11px]">
              {isLoading && sessions.length === 0 && <SkeletonRows columns={5} rows={3} />}
              {!isLoading && sessions.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 px-3 text-center text-slate-400">
                    No active sessions are listed.
                  </td>
                </tr>
              )}
              {sessions.map((session, index) => (
                <MotionTr key={session.id} {...staggerProps(index)} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-2.5 px-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-white">{summariseUserAgent(session.userAgent)}</span>
                      {session.current && (
                        <span className="px-2 py-0.5 rounded-full bg-[#22C55E]/15 text-[#22C55E] border border-[#22C55E]/30 text-[10px] font-bold">This Device</span>
                      )}
                    </div>
                    {session.userAgent && (
                      <div className="text-[10px] text-slate-400 truncate max-w-[280px]" title={session.userAgent}>
                        {session.userAgent}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-slate-300">{session.ipAddress || '—'}</td>
                  <td className="py-2.5 px-3 font-mono text-slate-300 whitespace-nowrap">{formatDateTime(session.createdAt)}</td>
                  <td className="py-2.5 px-3 font-mono text-slate-300 whitespace-nowrap">{formatDateTime(session.lastUsedAt)}</td>
                  <td className="py-2.5 px-3 text-right">
                    <button
                      type="button"
                      onClick={() => setPendingRevoke(session)}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-bold text-rose-300 border border-rose-500/30 hover:bg-rose-500/10 transition-colors whitespace-nowrap"
                      aria-label={session.current ? 'Sign out of this device' : `Sign out the session on ${summariseUserAgent(session.userAgent)}`}
                    >
                      {session.current ? 'Sign Out' : 'Revoke'}
                    </button>
                  </td>
                </MotionTr>
              ))}
            </tbody>
          </table>
        </div>
        {!isLoading && sessions.length > 0 && (
          <p className="text-[11px] text-slate-400">
            {otherSessions === 0 ? 'This is your only active session.' : `${otherSessions} other ${otherSessions === 1 ? 'session is' : 'sessions are'} active.`}
          </p>
        )}
      </section>

      <ChangePasswordCard email={currentUser?.email} onChanged={onPasswordChanged ?? onCurrentSessionRevoked} />

      {/* Audit trail tamper-evidence check: Super Administrators only (enforced again by the API) */}
      {currentUser?.role === 'SUPER_ADMIN' && <AuditChainCard />}

      {/* Outgoing email settings and test message: Super Administrators only (enforced again by the API) */}
      {currentUser?.role === 'SUPER_ADMIN' && <MailDiagnostics email={currentUser.email} />}

      <ConfirmDialog
        open={pendingRevoke !== null}
        title={pendingRevoke?.current ? 'Sign Out of This Device' : 'Revoke Session'}
        message={
          pendingRevoke?.current
            ? 'Sign out of the session on this device? You will return to the sign-in screen.'
            : `Sign out the session on ${summariseUserAgent(pendingRevoke?.userAgent)}${pendingRevoke?.ipAddress ? ` (${pendingRevoke.ipAddress})` : ''}? That device will need to sign in again. You will be asked to confirm your identity.`
        }
        confirmLabel={pendingRevoke?.current ? 'Sign Out' : 'Revoke Session'}
        tone="danger"
        busy={isRevoking}
        onConfirm={handleRevoke}
        onCancel={() => setPendingRevoke(null)}
      />
    </div>
  );
}

/** Voluntary password change (POST /auth/change-password). The API signs out every session afterwards. */
function ChangePasswordCard({ email, onChanged }: { email?: string | null; onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!current) return setError('Please enter your current password.');
    if (next !== confirm) return setError('The new passwords do not match.');
    const policyError = passwordPolicyError(next, email);
    if (policyError) return setError(policyError);
    if (next === current) return setError('The new password must be different from the current password.');
    setBusy(true);
    try {
      await adminFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next })
      });
      setCurrent('');
      setNext('');
      setConfirm('');
      onChanged();
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`The password could not be changed. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={CARD_CLASS} aria-labelledby="change-password-heading">
      <SectionHeading
        id="change-password-heading"
        title="Change Password"
        icon={LockKeyhole}
        description="Changing your password signs you out of every session, including this one."
      />
      <Notice tone="error" message={error} onDismiss={() => setError(null)} />
      <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-4" noValidate>
        <div className="space-y-3">
          <Field label="Current password" required>
            {(props) => (
              <input
                {...props}
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                className={INPUT_CLASS}
              />
            )}
          </Field>
          <Field label="New password" required>
            {(props) => (
              <input
                {...props}
                type="password"
                autoComplete="new-password"
                aria-describedby="security-pw-policy"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                className={INPUT_CLASS}
              />
            )}
          </Field>
          <Field label="Confirm new password" required>
            {(props) => (
              <input
                {...props}
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={INPUT_CLASS}
              />
            )}
          </Field>
          <button type="submit" disabled={busy} className={BUTTON_PRIMARY}>
            {busy ? 'Changing Password...' : 'Change Password'}
          </button>
        </div>
        <div className="text-xs">
          <PasswordPolicyList id="security-pw-policy" password={next} email={email} />
        </div>
      </form>
    </section>
  );
}

/** "Verify audit chain" (GET /audit/verify-chain): reports the first broken link of the audit hash chain. */
function AuditChainCard() {
  const [report, setReport] = useState<AuditChainReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await verifyAuditChain());
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`The audit chain could not be verified. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setBusy(false);
    }
  };

  const brk = report?.firstBreak;
  return (
    <section className={CARD_CLASS} aria-labelledby="audit-chain-heading" aria-busy={busy}>
      <SectionHeading
        id="audit-chain-heading"
        title="Audit Trail Integrity"
        icon={Fingerprint}
        description="Every audit entry is linked to the previous one by a cryptographic hash. Verification recomputes the chain and reports the first entry that was changed, removed or inserted."
        actions={
          <button type="button" onClick={() => void run()} disabled={busy} className={`${BUTTON_SECONDARY} flex items-center gap-2`}>
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
            {busy ? 'Verifying...' : 'Verify Audit Chain'}
          </button>
        }
      />
      <Notice tone="error" message={error} onDismiss={() => setError(null)} />
      <div role="status" aria-live="polite" className="text-xs">
        {report && report.ok && (
          <p className="text-emerald-300">
            The audit chain is intact: {report.checkedRows} {report.checkedRows === 1 ? 'entry was' : 'entries were'} verified
            {report.legacyRows > 0
              ? ` (${report.legacyRows} earlier ${report.legacyRows === 1 ? 'entry predates' : 'entries predate'} the chain and ${report.legacyRows === 1 ? 'is' : 'are'} not covered)`
              : ''}
            .
          </p>
        )}
        {report && !report.ok && brk && (
          <div className="p-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-200 space-y-1">
            <p className="font-bold">The audit chain is broken. {brk.message}</p>
            <p className="font-mono text-[11px]">
              First broken link: position {brk.chainSeq ?? 'unknown'}, entry {brk.id ?? 'missing'}
              {brk.action ? `, action ${brk.action}` : ''}
              {brk.createdAt ? `, recorded ${formatDateTime(brk.createdAt)}` : ''}. {report.checkedRows} earlier{' '}
              {report.checkedRows === 1 ? 'entry' : 'entries'} verified.
            </p>
          </div>
        )}
        {!report && !error && <p className="text-slate-400">Verification has not been run in this session.</p>}
      </div>
    </section>
  );
}
