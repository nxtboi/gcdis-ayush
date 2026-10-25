'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Users, Search, Plus, IdCard, Edit2, Shield, User, GraduationCap, UserMinus } from 'lucide-react';
import { memberRoleLabel, reviewStatusClass, reviewStatusLabel, type TeamMember } from './types';
import { DURATION, EASE_OUT, MotionButton } from './motion';

export type RoleFilter = 'ALL' | 'CAPTAIN' | 'FACULTY' | 'MEMBER';

const ROLE_FILTER_OPTIONS: { value: RoleFilter; label: string }[] = [
  { value: 'ALL', label: 'All roles' },
  { value: 'CAPTAIN', label: 'Captain' },
  { value: 'FACULTY', label: 'Coaches and advisors' },
  { value: 'MEMBER', label: 'Pilots and pit crew' }
];

interface MembersTabProps {
  /** Members after search/role filtering. */
  members: TeamMember[];
  totalCount: number;
  /** True while the roster is being loaded for the first time. */
  loading: boolean;
  loadError: string | null;
  searchMember: string;
  setSearchMember: (value: string) => void;
  roleFilter: RoleFilter;
  setRoleFilter: (value: RoleFilter) => void;
  onInvite: () => void;
  onViewCard: (member: TeamMember) => void;
  onEdit: (member: TeamMember) => void;
  /** Opens the removal confirmation for a non-captain member. */
  onRemove: (member: TeamMember) => void;
  /**
   * Explanation shown when the roster is final (registration approved): members can then no longer be
   * added, edited or removed. Null while the roster may still change.
   */
  removeLockedReason: string | null;
  onGoToOverview: () => void;
  /** False until the team has been saved; members can then be managed online. */
  canManage: boolean;
  maxTeamSize: number;
}

function RolePill({ member }: { member: TeamMember }) {
  const label = memberRoleLabel(member.roleCode);
  if (member.roleType === 'captain') {
    return (
      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-[#DCFCE7] text-[#15803D] border border-[#86EFAC] text-[10px] font-black tracking-wider uppercase">
        <Shield className="w-3 h-3" aria-hidden="true" />
        {label}
      </span>
    );
  }
  if (member.roleType === 'faculty') {
    return (
      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-black tracking-wider uppercase">
        <GraduationCap className="w-3 h-3" aria-hidden="true" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200 text-[10px] font-black tracking-wider uppercase">
      <User className="w-3 h-3" aria-hidden="true" />
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block whitespace-nowrap border text-[10px] font-mono font-bold px-2 py-0.5 rounded ${reviewStatusClass(status)}`}
    >
      {reviewStatusLabel(status).toUpperCase()}
    </span>
  );
}

const rowMotion = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0 }
};

export default function MembersTab({
  members,
  totalCount,
  loading,
  loadError,
  searchMember,
  setSearchMember,
  roleFilter,
  setRoleFilter,
  onInvite,
  onViewCard,
  onEdit,
  onRemove,
  removeLockedReason,
  onGoToOverview,
  canManage,
  maxTeamSize
}: MembersTabProps) {
  const rosterFull = totalCount >= maxTeamSize;
  const inviteHint = !canManage
    ? 'Please complete your team registration before adding members.'
    : removeLockedReason
      ? undefined
      : rosterFull
      ? `The roster has reached the maximum of ${maxTeamSize} members.`
      : undefined;

  const emptyMessage = loading
    ? 'Loading team members…'
    : loadError
      ? loadError
      : totalCount === 0
        ? 'No team members are on record yet.'
        : 'No members match the current search or role filter.';

  const editButtonClass =
    'inline-flex items-center gap-1 px-3 py-1 rounded-full bg-[#DCFCE7] hover:bg-[#bbf7d0] text-[#15803D] border border-[#86EFAC] text-[10px] font-black uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[#DCFCE7]';
  const removeButtonClass =
    'inline-flex items-center gap-1 px-3 py-1 rounded-full bg-white hover:bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-black uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white';
  const removeDisabledReason = !canManage
    ? 'Please complete your team registration before managing members.'
    : removeLockedReason;
  /** Edits are refused by the API once the roster is final, exactly like removals. */
  const editDisabledReason = !canManage ? undefined : removeLockedReason;

  /** Remove action for non-captain members (the captain's row cannot be removed). */
  const renderRemoveButton = (member: TeamMember) => {
    if (member.roleType === 'captain' || member.roleCode.toUpperCase() === 'CAPTAIN') return null;
    return (
      <button
        type="button"
        onClick={() => onRemove(member)}
        aria-label={`Remove ${member.name} from the team`}
        disabled={Boolean(removeDisabledReason)}
        title={removeDisabledReason ?? undefined}
        aria-describedby={removeLockedReason && canManage ? 'members-remove-hint' : undefined}
        className={removeButtonClass}
      >
        <UserMinus className="w-3 h-3" aria-hidden="true" />
        <span>Remove</span>
      </button>
    );
  };
  const cardButtonClass =
    'inline-flex items-center gap-1 text-slate-600 hover:text-[#15803D] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#22C55E] rounded';

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="bg-white border border-slate-200/80 rounded-2xl p-4 sm:p-6 shadow-sm space-y-6">
        {/* Table Header Bar */}
        <div className="flex flex-col xl:flex-row items-start xl:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 shrink-0 rounded-xl bg-[#DCFCE7] text-[#15803D] flex items-center justify-center">
              <Users className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="team-members-heading" tabIndex={-1} className="text-base font-black text-slate-900 uppercase focus:outline-none">Team Members</h2>
              <span className="bg-[#DCFCE7] text-[#15803D] border border-[#86EFAC] text-xs font-bold px-2.5 py-0.5 rounded-full tabular-nums">
                {totalCount} / {maxTeamSize} MEMBERS
              </span>
            </div>
          </div>

          {/* Search, Filter & Add Action */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 w-full xl:w-auto">
            <div className="relative flex-1 sm:min-w-[14rem]">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                type="search"
                aria-label="Search team members by name, email or role"
                value={searchMember}
                onChange={(e) => setSearchMember(e.target.value)}
                placeholder="Search by name, email or role"
                className="w-full pl-8 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-full text-xs text-slate-800 placeholder-slate-400 transition-[border-color,box-shadow] duration-200 focus:outline-none focus:border-[#22C55E] focus:ring-4 focus:ring-[#22C55E]/15"
              />
            </div>

            <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto">
              <label htmlFor="members-role-filter" className="sr-only">
                Filter by role
              </label>
              <select
                id="members-role-filter"
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
                className="min-w-0 flex-1 sm:flex-initial py-2 pl-3 pr-8 bg-slate-50 border border-slate-200 rounded-full text-xs font-semibold text-slate-700 focus:outline-none focus:border-[#22C55E] focus:ring-4 focus:ring-[#22C55E]/15"
              >
                {ROLE_FILTER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>

              <MotionButton
                type="button"
                onClick={onInvite}
                disabled={!canManage || rosterFull || Boolean(removeLockedReason)}
                title={inviteHint ?? removeLockedReason ?? undefined}
                aria-describedby={inviteHint ? 'members-invite-hint' : removeLockedReason && canManage ? 'members-remove-hint' : undefined}
                className="disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#22C55E] enabled:hover:bg-[#15803D] enabled:hover:text-white text-slate-950 font-black text-xs uppercase tracking-wider transition-colors shadow-sm shrink-0"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Add Member</span>
              </MotionButton>
            </div>
          </div>
        </div>

        {inviteHint && (
          <p id="members-invite-hint" className="-mt-2 text-[11px] font-semibold text-slate-500">
            {inviteHint}{' '}
            {!canManage && (
              <button type="button" onClick={onGoToOverview} className="font-black text-[#15803D] underline underline-offset-2">
                Complete team registration
              </button>
            )}
          </p>
        )}

        {canManage && removeLockedReason && (
          <p id="members-remove-hint" className="-mt-2 text-[11px] font-semibold text-slate-500">
            {removeLockedReason}
          </p>
        )}

        {/* Members table (tablet and desktop) */}
        <div className="hidden md:block overflow-x-auto border-t border-slate-100 pt-2">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Team roster</caption>
            <thead>
              <tr className="text-[10px] font-black text-slate-400 uppercase tracking-wider border-b border-slate-100">
                <th scope="col" className="py-3 px-4">
                  Name
                </th>
                <th scope="col" className="py-3 px-4">
                  Role
                </th>
                <th scope="col" className="py-3 px-4">
                  Email
                </th>
                <th scope="col" className="py-3 px-4">
                  Mobile
                </th>
                <th scope="col" className="py-3 px-4">
                  ID Card
                </th>
                <th scope="col" className="py-3 px-4">
                  Status
                </th>
                <th scope="col" className="py-3 px-4 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              <AnimatePresence initial={true}>
                {members.map((member, index) => (
                  <motion.tr
                    key={member.id}
                    layout="position"
                    {...rowMotion}
                    transition={{
                      duration: DURATION.base,
                      ease: EASE_OUT,
                      delay: Math.min(index, 10) * 0.035
                    }}
                    className="hover:bg-slate-50/70 transition-colors"
                  >
                    <th scope="row" className="py-4 px-4 font-bold text-slate-900">
                      {member.name}
                    </th>
                    <td className="py-4 px-4">
                      <RolePill member={member} />
                    </td>
                    <td className="py-4 px-4 font-mono text-slate-600 break-all">{member.email}</td>
                    <td className="py-4 px-4 font-mono text-slate-600 whitespace-nowrap">{member.mobile || '—'}</td>
                    <td className="py-4 px-4">
                      <button
                        type="button"
                        onClick={() => onViewCard(member)}
                        aria-label={`View the accreditation card of ${member.name}`}
                        className={cardButtonClass}
                      >
                        <IdCard className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                        <span>View</span>
                      </button>
                    </td>
                    <td className="py-4 px-4">
                      <StatusBadge status={member.status} />
                    </td>
                    <td className="py-4 px-4 text-right">
                      <div className="inline-flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => onEdit(member)}
                          aria-label={`Edit ${member.name}`}
                          disabled={!canManage || Boolean(editDisabledReason)}
                          title={editDisabledReason ?? undefined}
                          className={editButtonClass}
                        >
                          <Edit2 className="w-3 h-3" aria-hidden="true" />
                          <span>Edit</span>
                        </button>
                        {renderRemoveButton(member)}
                      </div>
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
              {members.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 px-4 text-center text-slate-500" role={loadError ? 'alert' : 'status'}>
                    {emptyMessage}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Member cards (mobile) */}
        <ul className="md:hidden space-y-3 border-t border-slate-100 pt-4" aria-label="Team roster">
          <AnimatePresence initial={true}>
            {members.map((member, index) => (
              <motion.li
                key={member.id}
                layout="position"
                {...rowMotion}
                transition={{
                  duration: DURATION.base,
                  ease: EASE_OUT,
                  delay: Math.min(index, 10) * 0.035
                }}
                className="rounded-xl border border-slate-200 p-4 space-y-3 text-xs"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-bold text-slate-900 break-words">{member.name}</div>
                    <div className="mt-1">
                      <RolePill member={member} />
                    </div>
                  </div>
                  <StatusBadge status={member.status} />
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px] text-slate-600">
                  <dt className="font-sans font-bold text-slate-400 uppercase text-[10px]">Email</dt>
                  <dd className="break-all">{member.email}</dd>
                  <dt className="font-sans font-bold text-slate-400 uppercase text-[10px]">Mobile</dt>
                  <dd>{member.mobile || '—'}</dd>
                </dl>
                <div className="flex items-center justify-between gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => onViewCard(member)}
                    aria-label={`View the accreditation card of ${member.name}`}
                    className={cardButtonClass}
                  >
                    <IdCard className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                    <span>View ID card</span>
                  </button>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onEdit(member)}
                      aria-label={`Edit ${member.name}`}
                      disabled={!canManage || Boolean(editDisabledReason)}
                      title={editDisabledReason ?? undefined}
                      className={editButtonClass}
                    >
                      <Edit2 className="w-3 h-3" aria-hidden="true" />
                      <span>Edit</span>
                    </button>
                    {renderRemoveButton(member)}
                  </div>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
          {members.length === 0 && (
            <li className="py-6 text-center text-xs text-slate-500" role={loadError ? 'alert' : 'status'}>
              {emptyMessage}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
