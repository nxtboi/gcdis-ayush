'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { MoreHorizontal, ShieldCheck, UserCheck, UserX } from 'lucide-react';
import { adminFetch, isSessionExpiredError, isStepUpCancelledError } from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, Modal } from './Modal';
import { EASE_OUT, Notice } from './motion';
import { roleLabel, type StaffUser } from './types';

/** Staff roles a Super Administrator may assign, with a formal description of each role's access. */
export const ASSIGNABLE_ROLES: { value: string; label: string; description: string }[] = [
  {
    value: 'SUPER_ADMIN',
    label: 'Super Administrator',
    description:
      'Full access to the staff console, including the creation of staff accounts, role assignment and account deactivation.'
  },
  {
    value: 'EVENT_ADMIN',
    label: 'Event Administrator',
    description:
      'Manages the overview, website content, registrations, scrutineering, scoring, prizes and the audit log. Cannot manage staff accounts or roles.'
  },
  {
    value: 'JUDGE',
    label: 'Judge',
    description: 'Access to competition scoring and to the security settings of their own account only.'
  },
  {
    value: 'INSPECTOR',
    label: 'Technical Inspector',
    description: 'Access to scrutineering inspections and to the security settings of their own account only.'
  }
];

export const STATUS_REASON_MAX = 300;

const MENU_WIDTH = 192;
/** Approximate height of the two-item menu, used to open it upwards near the bottom of the window. */
const MENU_HEIGHT = 84;

const FIELD = 'bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-white w-full text-xs focus:outline-none focus:border-[#22C55E]';

/** Message for a failed user-management request; a cancelled identity confirmation is reported as such. */
function failureMessage(err: unknown, prefix: string): string {
  if (isStepUpCancelledError(err)) return err.message;
  return `${prefix} ${errorMessage(err, 'Please try again.')}`;
}

interface StaffActionsMenuProps {
  user: StaffUser;
  isSelf: boolean;
  onChangeRole: (user: StaffUser) => void;
  onChangeStatus: (user: StaffUser) => void;
}

/**
 * Per-row actions menu (menu button pattern): Enter, Space or Arrow Down opens it and focuses the
 * first item, arrow keys move between items, Escape closes it and returns focus to the button.
 * Disabled with an explanation on the signed-in user's own row.
 */
export function StaffActionsMenu({ user, isSelf, onChangeRole, onChangeStatus }: StaffActionsMenuProps) {
  const [open, setOpen] = useState(false);
  // Fixed position next to the button: the table container scrolls horizontally and would clip an absolute menu
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const active = user.isActive !== false;
  const name = user.fullName || user.email;

  useEffect(() => {
    if (!open) return;
    const focusFirst = window.setTimeout(() => menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(), 0);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    const onViewportChange = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.clearTimeout(focusFirst);
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open]);

  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = MENU_WIDTH;
      const height = MENU_HEIGHT;
      const below = rect.bottom + 4;
      const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below;
      const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
      setPosition({ top, left });
    }
    setOpen(true);
  };

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  if (isSelf) {
    const explanation = 'You cannot change the role or status of your own account. Another Super Administrator must do this.';
    return (
      <span title={explanation} className="inline-flex">
        <button
          type="button"
          disabled
          aria-label={`Actions for ${name} (unavailable: ${explanation})`}
          className="p-1.5 rounded-lg text-slate-600 cursor-not-allowed"
        >
          <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
        </button>
      </span>
    );
  }

  const ITEM =
    'w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-sans rounded-lg text-slate-200 hover:bg-slate-800 focus:bg-slate-800 focus:outline-none transition-colors';

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Actions for ${name}`}
        title="Account actions"
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            openMenu();
          }
        }}
        className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#22C55E]"
      >
        <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={`Actions for ${name}`}
            onKeyDown={onMenuKeyDown}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.18, ease: EASE_OUT } }}
            exit={{ opacity: 0, y: -2, transition: { duration: 0.12, ease: EASE_OUT } }}
            style={position ? { position: 'fixed', top: position.top, left: position.left, width: MENU_WIDTH } : undefined}
            className="fixed z-40 p-1 bg-[#111625] border border-slate-700 rounded-xl shadow-xl shadow-black/40"
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={ITEM}
              onClick={() => {
                close(false);
                onChangeRole(user);
              }}
            >
              <ShieldCheck className="w-3.5 h-3.5 text-[#22C55E]" aria-hidden="true" />
              Change Role
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={ITEM}
              onClick={() => {
                close(false);
                onChangeStatus(user);
              }}
            >
              {active ? (
                <UserX className="w-3.5 h-3.5 text-rose-300" aria-hidden="true" />
              ) : (
                <UserCheck className="w-3.5 h-3.5 text-emerald-300" aria-hidden="true" />
              )}
              {active ? 'Deactivate' : 'Reactivate'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface DialogProps {
  user: StaffUser | null;
  onClose: () => void;
  onUpdated: (user: StaffUser, message: string) => void;
}

/** Change Role: role select with the access of each role, then explicit confirmation. */
export function ChangeRoleDialog({ user, onClose, onUpdated }: DialogProps) {
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (user) {
      setRole(user.role ?? '');
      setError(null);
      setBusy(false);
    }
  }, [user]);

  const name = user?.fullName || user?.email || 'this account';
  const selected = ASSIGNABLE_ROLES.find((r) => r.value === role);
  const unchanged = !!user && role === user.role;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!user || unchanged || !selected) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await adminFetch<StaffUser>(`/auth/users/${encodeURIComponent(user.id)}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role })
      });
      onUpdated(updated ?? { ...user, role }, `The role of ${name} has been changed to ${selected.label}. The account's active sessions have been ended.`);
    } catch (err) {
      if (isSessionExpiredError(err)) return;
      setError(failureMessage(err, 'The role could not be changed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={user !== null}
      title="Change Role"
      description={`Assign a staff role to ${name}. The current role is ${roleLabel(user?.role)}.`}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor={selectId} className="block text-xs font-bold text-slate-300 mb-1">
            New Role
          </label>
          <select
            id={selectId}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            aria-describedby={descriptionId}
            disabled={busy}
            className={FIELD}
            data-autofocus
          >
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
                {r.value === user?.role ? ' (current role)' : ''}
              </option>
            ))}
          </select>
        </div>
        <dl id={descriptionId} className="space-y-2" aria-label="Access granted by each role">
          {ASSIGNABLE_ROLES.map((r) => (
            <div
              key={r.value}
              className={`rounded-xl border px-3 py-2 transition-colors ${
                r.value === role ? 'border-[#22C55E]/60 bg-emerald-500/5' : 'border-slate-800'
              }`}
            >
              <dt className={`text-xs font-bold ${r.value === role ? 'text-[#22C55E]' : 'text-slate-200'}`}>{r.label}</dt>
              <dd className="text-[11px] text-slate-400 leading-relaxed">{r.description}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[11px] text-amber-200/90 leading-relaxed">
          Changing the role ends every active session of this account; the new role applies when the user next signs in. You
          will be asked to confirm your identity with an authentication code.
        </p>
        <Notice tone="error" message={error} onDismiss={() => setError(null)} />
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={busy} className={BUTTON_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={busy || unchanged || !selected} className={BUTTON_PRIMARY}>
            {busy ? 'Please Wait…' : 'Confirm Role Change'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Deactivate / Reactivate with an optional reason recorded in the audit log. */
export function AccountStatusDialog({ user, onClose, onUpdated }: DialogProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const counterId = useId();

  useEffect(() => {
    if (user) {
      setReason('');
      setError(null);
      setBusy(false);
    }
  }, [user]);

  const deactivating = user?.isActive !== false;
  const name = user?.fullName || user?.email || 'this account';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!user) return;
    setBusy(true);
    setError(null);
    const trimmed = reason.trim();
    try {
      const updated = await adminFetch<StaffUser>(`/auth/users/${encodeURIComponent(user.id)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !deactivating, ...(trimmed ? { reason: trimmed } : {}) })
      });
      onUpdated(
        updated ?? { ...user, isActive: !deactivating },
        deactivating
          ? `The account of ${name} has been deactivated and its active sessions have been ended.`
          : `The account of ${name} has been reactivated.`
      );
    } catch (err) {
      if (isSessionExpiredError(err)) return;
      setError(failureMessage(err, deactivating ? 'The account could not be deactivated.' : 'The account could not be reactivated.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={user !== null}
      title={deactivating ? 'Deactivate Account' : 'Reactivate Account'}
      description={`${name} (${roleLabel(user?.role)})`}
      onClose={onClose}
      busy={busy}
      size="sm"
    >
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-slate-300 leading-relaxed">
          {deactivating
            ? 'The user will be signed out of every device immediately and will not be able to sign in until the account is reactivated. Records created by the account are retained.'
            : 'The user will be able to sign in again with the existing password and two-factor authentication.'}
        </p>
        <div>
          <label htmlFor={reasonId} className="block text-xs font-bold text-slate-300 mb-1">
            Reason <span className="font-normal text-slate-400">(optional, recorded in the audit log)</span>
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, STATUS_REASON_MAX))}
            maxLength={STATUS_REASON_MAX}
            rows={3}
            disabled={busy}
            aria-describedby={counterId}
            className={`${FIELD} resize-none`}
            data-autofocus
          />
          <div id={counterId} className="text-[10px] text-slate-400 text-right mt-1">
            {reason.length} of {STATUS_REASON_MAX} characters
          </div>
        </div>
        <Notice tone="error" message={error} onDismiss={() => setError(null)} />
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={busy} className={BUTTON_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={deactivating ? BUTTON_DANGER : BUTTON_PRIMARY}>
            {busy ? 'Please Wait…' : deactivating ? 'Deactivate Account' : 'Reactivate Account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
