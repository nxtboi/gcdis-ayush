'use client';

import React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Loader2, Printer } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { Logo } from '@/components/brand/Logo';
import { getSiteUrl } from '@/lib/api-client';
import { memberRoleLabel, reviewStatusLabel, type TeamInfo, type TeamMember } from './types';
import { FadeIn, MotionButton } from './motion';

interface MemberCardModalProps {
  member: TeamMember;
  teamInfo: TeamInfo;
  onClose: () => void;
  onDownloadPass: (member: TeamMember) => void;
  downloadError: string | null;
  isDownloading: boolean;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts[parts.length - 1][0]}`;
  return letters.toUpperCase();
}

/** Digital accreditation badge preview for a team member (loaded on demand). */
export default function MemberCardModal({
  member,
  teamInfo,
  onClose,
  onDownloadPass,
  downloadError,
  isDownloading
}: MemberCardModalProps) {
  const verifyUrl = `${getSiteUrl()}/verify/id/${encodeURIComponent(`${teamInfo.teamId}-${member.id}`)}`;

  return (
    <Modal
      title={`Accreditation Card: ${member.name}`}
      hideHeader
      onClose={onClose}
      panelClassName="max-w-sm p-6 space-y-4 text-center"
    >
      {/* Badge Header */}
      <div className="bg-[#111625] text-white rounded-2xl p-4 space-y-1.5">
        <div className="mx-auto w-fit">
          <Logo size={36} />
        </div>
        <div className="text-xs font-black tracking-widest text-[#22C55E] uppercase">GCDIS Participant Accreditation</div>
        <div className="text-[10px] text-slate-300">Drone Soccer Championship 2026 • Galgotias University</div>
      </div>

      {/* Member Details */}
      <div className="space-y-1 pt-2">
        <div
          className="w-16 h-16 rounded-full bg-slate-100 border-2 border-[#22C55E] mx-auto flex items-center justify-center text-xl font-black text-slate-800 font-mono"
          aria-hidden="true"
        >
          {initials(member.name)}
        </div>
        <h3 className="text-base font-black text-slate-900 pt-1 break-words">{member.name}</h3>
        <div className="text-xs font-bold text-[#15803D] uppercase">{memberRoleLabel(member.roleCode)}</div>
        <div className="text-[11px] text-slate-500 font-medium">
          {teamInfo.name ? `Team ${teamInfo.name}` : ''}
          {teamInfo.name && teamInfo.institute ? ' • ' : ''}
          {teamInfo.institute}
        </div>
      </div>

      {/* QR Code (preview) */}
      <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl inline-block mx-auto">
        <QRCodeSVG value={verifyUrl} size={120} level="M" title={`Verification code for ${member.name}`} />
      </div>
      <p className="text-[10px] text-slate-500">
        Preview only. The signed verification QR code is printed on the downloadable PDF pass.
      </p>

      <dl className="text-[10px] font-mono text-slate-500 space-y-0.5">
        <div>
          <dt className="inline">REGISTRATION: </dt>
          <dd className="inline font-bold text-slate-900">{teamInfo.registrationCode || 'Not yet submitted'}</dd>
        </div>
        <div>
          <dt className="inline">MEMBER STATUS: </dt>
          <dd className="inline font-bold text-[#15803D]">{reviewStatusLabel(member.status).toUpperCase()}</dd>
        </div>
      </dl>

      {downloadError && (
        <FadeIn role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700">
          {downloadError}
        </FadeIn>
      )}

      <MotionButton
        type="button"
        onClick={() => onDownloadPass(member)}
        disabled={isDownloading}
        className="w-full py-2.5 rounded-full bg-slate-900 hover:bg-slate-800 disabled:opacity-60 disabled:cursor-wait text-white text-xs font-bold uppercase transition-colors flex items-center justify-center gap-2"
      >
        {isDownloading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <Printer className="w-3.5 h-3.5" aria-hidden="true" />
        )}
        <span>{isDownloading ? 'Preparing PDF…' : 'Download Accreditation Pass (PDF)'}</span>
      </MotionButton>
    </Modal>
  );
}
