'use client';

import React, { useState } from 'react';
import { Info, Loader2 } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { fetchApi } from '../../../lib/api-client';
import type { MemberDraft, TeamInfo } from './types';
import { FadeIn, MotionButton } from './motion';

interface MemberRequestModalProps {
  mode: 'invite' | 'edit';
  teamInfo: TeamInfo;
  /** Existing member values when editing (`role` is the API memberRole code, e.g. PILOT). */
  initial?: MemberDraft & { id?: string };
  /** Current roster, used to show the FIDA limits before submitting. */
  memberCount: number;
  coachCount: number;
  onClose: () => void;
  /** Called after the API saved the change, so the roster can be reloaded. */
  onSaved: () => void;
}

/** Roles a captain may assign (TeamMemberRole without CAPTAIN, which belongs to the account holder). */
const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'PILOT', label: 'Pilot' },
  { value: 'PIT_CREW', label: 'Pit crew' },
  { value: 'COACH', label: 'Coach' },
  { value: 'ADVISOR', label: 'Advisor' }
];

const MAX_COACHES = 3;
const EMPTY_DRAFT: MemberDraft = {
  name: '',
  role: 'PILOT',
  email: '',
  mobile: ''
};

/** Same rule as the API (TeamMemberDto.phone): 7–20 characters of digits, with an optional leading + and spaces or hyphens. */
export const MEMBER_PHONE_PATTERN = '\\+?[0-9][0-9 \\-]{5,18}[0-9]';

const inputClass =
  'w-full p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-slate-900 transition-[border-color,box-shadow] duration-200 focus:outline-none focus:border-[#22C55E] focus:ring-4 focus:ring-[#22C55E]/15 disabled:opacity-70';

/** Add or edit a team member through POST /teams/:id/members and PATCH /teams/:id/members/:memberId. */
export default function MemberRequestModal({
  mode,
  teamInfo,
  initial,
  memberCount,
  coachCount,
  onClose,
  onSaved
}: MemberRequestModalProps) {
  const [draft, setDraft] = useState<MemberDraft>(initial ? { ...EMPTY_DRAFT, ...initial } : EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isInvite = mode === 'invite';
  const idPrefix = isInvite ? 'invite' : 'edit';
  const isCaptain = !isInvite && initial?.role === 'CAPTAIN';
  const rosterFull = isInvite && memberCount >= teamInfo.maxTeamSize;
  const hasTeam = Boolean(teamInfo.teamRecordId);
  // A member who is already a coach keeps the option; otherwise it is offered only while a coach place is free.
  const coachPlacesFull = coachCount >= MAX_COACHES && initial?.role !== 'COACH';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = draft.name.trim();
    const email = draft.email.trim();
    if (!hasTeam) return;
    if (!name) {
      setError("Please enter the member's full name.");
      return;
    }
    if (!isCaptain && !email) {
      setError("Please enter the member's email address.");
      return;
    }
    if (draft.role === 'COACH' && coachPlacesFull) {
      setError(`A team may have at most ${MAX_COACHES} coaches. Please choose another role.`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const payload: Record<string, string> = { fullName: name };
      const mobile = draft.mobile.trim();
      // When editing, an empty value clears the stored number; when adding, it is simply omitted.
      if (mobile || !isInvite) payload.phone = mobile;
      if (!isCaptain) {
        payload.email = email;
        payload.memberRole = draft.role;
      }
      const teamPath = `/teams/${encodeURIComponent(teamInfo.teamRecordId)}/members`;
      if (isInvite) {
        await fetchApi(teamPath, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      } else {
        await fetchApi(`${teamPath}/${encodeURIComponent(initial?.id ?? '')}`, {
          method: 'PATCH',
          body: JSON.stringify(payload)
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The change could not be saved. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const roleOptions = isCaptain ? [{ value: 'CAPTAIN', label: 'Captain' }] : ROLE_OPTIONS;
  const knownRole = roleOptions.some((o) => o.value === draft.role);

  return (
    <Modal title={isInvite ? 'Add a Team Member' : `Edit Team Member: ${initial?.name ?? ''}`} onClose={onClose}>
      <div className="p-3 bg-slate-50 border border-slate-200 text-slate-700 rounded-xl text-[11px] font-medium flex items-start gap-2">
        <Info className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          Under the FIDA regulations a team may have at most {teamInfo.maxTeamSize} members, including the captain, of whom no
          more than {MAX_COACHES} may be coaches. Current roster: {memberCount} member{memberCount === 1 ? '' : 's'}, {coachCount}{' '}
          coach
          {coachCount === 1 ? '' : 'es'}.
        </span>
      </div>

      {!hasTeam && (
        <p role="alert" className="text-[11px] font-semibold text-rose-600">
          Please complete your team registration on the Overview page before adding members.
        </p>
      )}
      {rosterFull && (
        <p role="alert" className="text-[11px] font-semibold text-rose-600">
          The roster has reached the maximum of {teamInfo.maxTeamSize} members.
        </p>
      )}

      <form onSubmit={handleSubmit} className="space-y-3 text-xs">
        <div>
          <label htmlFor={`${idPrefix}-name`} className="block font-bold text-slate-700 mb-1">
            Full Name
          </label>
          <input
            id={`${idPrefix}-name`}
            type="text"
            required
            maxLength={120}
            autoComplete="off"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="e.g. Rahul Sharma"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor={`${idPrefix}-role`} className="block font-bold text-slate-700 mb-1">
            Role in Team
          </label>
          <select
            id={`${idPrefix}-role`}
            value={draft.role}
            disabled={isCaptain}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
            aria-describedby={coachPlacesFull && !isCaptain ? `${idPrefix}-role-hint` : undefined}
            className={inputClass}
          >
            {roleOptions.map((o) => (
              <option key={o.value} value={o.value} disabled={o.value === 'COACH' && coachPlacesFull}>
                {o.value === 'COACH' && coachPlacesFull ? `${o.label} (all ${MAX_COACHES} places filled)` : o.label}
              </option>
            ))}
            {!knownRole && <option value={draft.role}>{draft.role.replace(/_/g, ' ')}</option>}
          </select>
          {coachPlacesFull && !isCaptain && (
            <p id={`${idPrefix}-role-hint`} className="mt-1 text-[11px] text-slate-500">
              All {MAX_COACHES} coach places are filled.
            </p>
          )}
        </div>

        <div>
          <label htmlFor={`${idPrefix}-email`} className="block font-bold text-slate-700 mb-1">
            Email Address
          </label>
          <input
            id={`${idPrefix}-email`}
            type="email"
            required
            maxLength={254}
            autoComplete="off"
            disabled={isCaptain}
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            placeholder="name@institution.ac.in"
            aria-describedby={isCaptain ? `${idPrefix}-email-hint` : undefined}
            className={inputClass}
          />
          {isCaptain && (
            <p id={`${idPrefix}-email-hint`} className="mt-1 text-[11px] text-slate-500">
              The captain&apos;s email address is the account email and cannot be changed here.
            </p>
          )}
        </div>

        <div>
          <label htmlFor={`${idPrefix}-mobile`} className="block font-bold text-slate-700 mb-1">
            Mobile Number <span className="font-medium text-slate-400">(optional)</span>
          </label>
          <input
            id={`${idPrefix}-mobile`}
            type="tel"
            inputMode="tel"
            maxLength={20}
            pattern={MEMBER_PHONE_PATTERN}
            title="Please use digits only, optionally with a leading + and spaces or hyphens."
            autoComplete="off"
            value={draft.mobile}
            onChange={(e) => setDraft({ ...draft, mobile: e.target.value })}
            placeholder="9876543210"
            className={inputClass}
          />
        </div>

        {error && (
          <FadeIn
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-[11px] font-semibold text-rose-700"
          >
            {error}
          </FadeIn>
        )}

        <div className="pt-2 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-full border border-slate-300 text-slate-700 font-bold transition-colors hover:bg-slate-50"
          >
            Cancel
          </button>
          <MotionButton
            type="submit"
            disabled={busy || !hasTeam || rosterFull}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-[#22C55E] enabled:hover:bg-[#15803D] enabled:hover:text-white disabled:opacity-60 disabled:cursor-not-allowed text-slate-950 font-black uppercase shadow-sm transition-colors"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            <span>{busy ? 'Saving…' : isInvite ? 'Add Member' : 'Save Changes'}</span>
          </MotionButton>
        </div>
      </form>
    </Modal>
  );
}
