'use client';

import React, { useState } from 'react';
import Pagination from './Pagination';
import { MotionTr, Notice, SkeletonRows, LoadingAnnouncement, staggerProps } from './motion';
import { AccountStatusDialog, ChangeRoleDialog, StaffActionsMenu } from './StaffManagement';
import CaptainAccounts from './CaptainAccounts';
import { hasTwoFactor, isStaffRole, roleLabel, type CreatedStaff, type PageState, type StaffUser } from './types';

interface UsersTabProps {
  userList: StaffUser[];
  currentUserRole?: string;
  /** Signed-in user: their own row has no role or status actions. */
  currentUserId?: string;
  /** Called with the updated account after a role or status change. */
  onUserUpdated?: (user: StaffUser) => void;
  newStaffName: string;
  setNewStaffName: (value: string) => void;
  newStaffEmail: string;
  setNewStaffEmail: (value: string) => void;
  newStaffRole: string;
  setNewStaffRole: (value: string) => void;
  handleCreateStaffUser: (e: React.FormEvent) => void;
  isCreatingStaff: boolean;
  createError: string | null;
  onDismissCreateError: () => void;
  createdStaff: CreatedStaff | null;
  onDismissCreatedStaff: () => void;
  isLoadingUsers: boolean;
  pageState: PageState;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

const FIELD = 'bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-white w-full focus:outline-none focus:border-[#22C55E]';

export default function UsersTab({
  userList,
  currentUserRole,
  currentUserId,
  onUserUpdated,
  newStaffName,
  setNewStaffName,
  newStaffEmail,
  setNewStaffEmail,
  newStaffRole,
  setNewStaffRole,
  handleCreateStaffUser,
  isCreatingStaff,
  createError,
  onDismissCreateError,
  createdStaff,
  onDismissCreatedStaff,
  isLoadingUsers,
  pageState,
  onPageChange,
  onPageSizeChange
}: UsersTabProps) {
  // Defence in depth: team captains are participants and never appear on the staff list
  const staffList = userList.filter((u) => isStaffRole(u.role));
  const canCreate = currentUserRole === 'SUPER_ADMIN';
  // Role and status management is limited to Super Administrators (enforced again by the API)
  const canManage = canCreate;
  const columns = canManage ? 6 : 5;
  const [roleTarget, setRoleTarget] = useState<StaffUser | null>(null);
  const [statusTarget, setStatusTarget] = useState<StaffUser | null>(null);
  const [manageSuccess, setManageSuccess] = useState<string | null>(null);

  const handleUpdated = (updated: StaffUser, message: string) => {
    setRoleTarget(null);
    setStatusTarget(null);
    setManageSuccess(message);
    onUserUpdated?.(updated);
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <section className="bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-4" aria-labelledby="create-staff-heading">
        <div>
          <h2 id="create-staff-heading" className="text-base font-black text-white tracking-tight">
            Create a Staff Account
          </h2>
          <p className="text-xs text-slate-400">
            {canCreate
              ? 'A temporary password is issued once. The new user must change it and set up two-factor authentication at first sign-in.'
              : 'Only a Super Administrator can create staff accounts.'}
          </p>
        </div>
        {canCreate && (
          <form onSubmit={handleCreateStaffUser} className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs items-end">
            <div>
              <label htmlFor="staff-name" className="block font-bold text-slate-300 mb-1">
                Full Name
              </label>
              <input
                id="staff-name"
                type="text"
                required
                minLength={2}
                maxLength={120}
                autoComplete="off"
                value={newStaffName}
                onChange={(e) => setNewStaffName(e.target.value)}
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="staff-email" className="block font-bold text-slate-300 mb-1">
                Email Address
              </label>
              <input
                id="staff-email"
                type="email"
                required
                autoComplete="off"
                value={newStaffEmail}
                onChange={(e) => setNewStaffEmail(e.target.value)}
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="staff-role" className="block font-bold text-slate-300 mb-1">
                Role
              </label>
              <select id="staff-role" value={newStaffRole} onChange={(e) => setNewStaffRole(e.target.value)} className={FIELD}>
                <option value="EVENT_ADMIN">Event Administrator</option>
                <option value="JUDGE">Judge</option>
                <option value="INSPECTOR">Technical Inspector</option>
                <option value="SUPER_ADMIN">Super Administrator</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={isCreatingStaff}
              className="py-2 bg-[#22C55E] hover:bg-[#16A34A] text-slate-950 font-black rounded-xl transition-colors disabled:opacity-60"
            >
              {isCreatingStaff ? 'Creating…' : 'Create Account'}
            </button>
          </form>
        )}
        <Notice tone="error" message={createError} onDismiss={onDismissCreateError} />
        <div role="status" aria-live="polite">
          {createdStaff && (
            <div className="p-4 bg-emerald-500/10 border border-emerald-500/40 text-emerald-300 rounded-xl text-xs space-y-2">
              <div className="font-bold">The staff account for {createdStaff.email} has been created.</div>
              {createdStaff.tempPassword ? (
                <div>
                  Temporary password (shown once; please share it through a secure channel):{' '}
                  <code className="font-mono font-bold text-white select-all">{createdStaff.tempPassword}</code>
                </div>
              ) : (
                <div>The temporary password has been delivered separately.</div>
              )}
              <button type="button" onClick={onDismissCreatedStaff} className="underline text-emerald-200 hover:text-white transition-colors">
                Dismiss
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-4" aria-labelledby="staff-list-heading">
        <div>
          <h2 id="staff-list-heading" className="text-base font-black text-white tracking-tight">
            Staff Accounts
          </h2>
          <p className="text-[11px] text-slate-400">
            Super administrators, event administrators, judges and technical inspectors. Team captains are managed through registrations.
            {canManage && ' Use the actions menu on a row to change a role or to deactivate or reactivate an account; both require confirmation with an authentication code.'}
          </p>
        </div>
        <Notice tone="success" message={manageSuccess} onDismiss={() => setManageSuccess(null)} />
        {isLoadingUsers && <LoadingAnnouncement label="Loading staff accounts." />}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-[10px] uppercase">
                <th scope="col" className="py-2 px-3">Name</th>
                <th scope="col" className="py-2 px-3">Email Address</th>
                <th scope="col" className="py-2 px-3">Role</th>
                <th scope="col" className="py-2 px-3">Two-Factor Authentication</th>
                <th scope="col" className="py-2 px-3">Account</th>
                {canManage && (
                  <th scope="col" className="py-2 px-3 text-right">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody className={`divide-y divide-slate-800/60 text-[11px] transition-opacity ${isLoadingUsers && staffList.length > 0 ? 'opacity-60' : ''}`}>
              {isLoadingUsers && staffList.length === 0 && <SkeletonRows columns={columns} rows={4} />}
              {!isLoadingUsers && staffList.length === 0 && (
                <tr>
                  <td colSpan={columns} className="py-4 px-3 text-center text-slate-400">
                    No staff accounts are listed on this page.
                  </td>
                </tr>
              )}
              {staffList.map((u, index) => {
                const twoFactor = hasTwoFactor(u);
                const active = u.isActive !== false;
                return (
                  <MotionTr key={u.id} {...staggerProps(index)} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-2 px-3 font-bold text-white">{u.fullName || '—'}</td>
                    <td className="py-2 px-3 text-slate-400 break-all">{u.email}</td>
                    <td className="py-2 px-3">
                      <span className="px-2 py-0.5 rounded bg-slate-800 text-[#22C55E] whitespace-nowrap">{roleLabel(u.role)}</span>
                    </td>
                    <td className={`py-2 px-3 ${twoFactor ? 'text-emerald-300' : 'text-amber-300'}`}>{twoFactor ? 'Enabled' : 'Not Enabled'}</td>
                    <td className={`py-2 px-3 ${active ? 'text-slate-300' : 'text-rose-300'}`}>{active ? 'Active' : 'Deactivated'}</td>
                    {canManage && (
                      <td className="py-2 px-3 text-right">
                        <StaffActionsMenu
                          user={u}
                          isSelf={!!currentUserId && u.id === currentUserId}
                          onChangeRole={(target) => {
                            setManageSuccess(null);
                            setRoleTarget(target);
                          }}
                          onChangeStatus={(target) => {
                            setManageSuccess(null);
                            setStatusTarget(target);
                          }}
                        />
                      </td>
                    )}
                  </MotionTr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination
          idPrefix="users"
          label="Staff accounts"
          state={pageState}
          isLoading={isLoadingUsers}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      </section>

      {/* Team captain email verification: Super Administrators only (enforced again by the API) */}
      {canManage && <CaptainAccounts />}

      {canManage && (
        <>
          <ChangeRoleDialog user={roleTarget} onClose={() => setRoleTarget(null)} onUpdated={handleUpdated} />
          <AccountStatusDialog user={statusTarget} onClose={() => setStatusTarget(null)} onUpdated={handleUpdated} />
        </>
      )}
    </div>
  );
}
