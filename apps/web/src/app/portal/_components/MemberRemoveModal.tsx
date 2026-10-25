'use client';

import React, { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { fetchApi } from '../../../lib/api-client';
import { memberRoleLabel, type TeamInfo, type TeamMember } from './types';
import { FadeIn, MotionButton } from './motion';

interface MemberRemoveModalProps {
  teamInfo: TeamInfo;
  member: TeamMember;
  onClose: () => void;
  /** Called after the API removed the member, so the roster can be reloaded and a notice shown. */
  onRemoved: (member: TeamMember) => void;
}

/** Confirmation dialog for DELETE /teams/:id/members/:memberId. */
export default function MemberRemoveModal({ teamInfo, member, onClose, onRemoved }: MemberRemoveModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRemove = async () => {
    if (busy || !teamInfo.teamRecordId) return;
    setError(null);
    setBusy(true);
    try {
      await fetchApi(
        `/teams/${encodeURIComponent(teamInfo.teamRecordId)}/members/${encodeURIComponent(member.id)}`,
        { method: 'DELETE' }
      );
      onRemoved(member);
      onClose();
    } catch (err) {
      // API refusals (e.g. 409 once the roster is final) are shown as returned
      setError(err instanceof Error && err.message ? err.message : 'The member could not be removed. Please try again.');
      setBusy(false);
    }
  };

  const descriptionId = `remove-member-${member.id}-description`;

  return (
    <Modal title="Remove Team Member" onClose={busy ? () => undefined : onClose}>
      <div id={descriptionId} className="space-y-3 text-xs text-slate-700">
        <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-[11px] font-semibold flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Remove {member.name} from the team? This cannot be undone.
          </span>
        </div>
        <p className="text-[11px] text-slate-500">
          {member.name} ({memberRoleLabel(member.roleCode)}) will no longer appear on the roster of {teamInfo.name || 'your team'}.
          The member may be added again later while the registration remains open for changes.
        </p>
      </div>

      {error && (
        <FadeIn role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-[11px] font-semibold text-rose-700">
          {error}
        </FadeIn>
      )}

      <div className="pt-2 flex items-center justify-end gap-3 text-xs">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="px-4 py-2 rounded-full border border-slate-300 text-slate-700 font-bold transition-colors hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        <MotionButton
          type="button"
          onClick={handleRemove}
          disabled={busy || !teamInfo.teamRecordId}
          aria-describedby={descriptionId}
          aria-busy={busy}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-rose-600 enabled:hover:bg-rose-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-black uppercase shadow-sm transition-colors"
        >
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          <span>{busy ? 'Removing…' : 'Remove Member'}</span>
        </MotionButton>
      </div>
    </Modal>
  );
}
