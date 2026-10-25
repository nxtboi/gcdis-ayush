'use client';

import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import Pagination from './Pagination';
import { Modal, BUTTON_PRIMARY, BUTTON_SECONDARY, BUTTON_DANGER } from './Modal';
import { MotionTr, Notice, SkeletonRows, LoadingAnnouncement, staggerProps } from './motion';
import {
  REASON_REQUIRED_STATUSES,
  nextRegistrationStatuses,
  statusLabel,
  type AdminRegistration,
  type PageState
} from './types';
import AwaitingVerificationPanel from './AwaitingVerificationPanel';
import RegistrationDetailDialog from './RegistrationDetailDialog';
import { pendingDocumentCount } from './documentReview';

/** Registration statuses accepted by the API's `status` filter (Prisma RegistrationStatus). */
export const REGISTRATION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'FACULTY_ENDORSED',
  'ADMINISTRATIVE_REVIEW',
  'PAYMENT_PENDING',
  'PAYMENT_VERIFIED',
  'DOCUMENT_REVIEW',
  'TECHNICAL_SUBMISSION',
  'TECHNICAL_INSPECTION',
  'ELIGIBILITY_REVIEW',
  'APPROVED',
  'ACCREDITED',
  'COMPETING',
  'ARENA_CLEARED',
  'COMPLETED',
  'REQUIRES_ACTION',
  'REJECTED',
  'WITHDRAWN',
  'CANCELLED'
] as const;

const NEGATIVE_STATUSES = ['REJECTED', 'CANCELLED', 'WITHDRAWN'];
const POSITIVE_STATUSES = ['APPROVED', 'ACCREDITED', 'COMPETING', 'ARENA_CLEARED', 'COMPLETED'];

function statusBadgeClass(status: string): string {
  if (NEGATIVE_STATUSES.includes(status)) return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
  if (status === 'REQUIRES_ACTION') return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  if (POSITIVE_STATUSES.includes(status)) return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
  return 'bg-slate-800 text-slate-300 border-slate-700';
}

const REASON_MAX = 500;

interface RegistrationsTabProps {
  registrations: AdminRegistration[];
  isLoadingRegistrations: boolean;
  loadRegistrations: () => void;
  /** Resolves when the API accepts the change; rejects with a formal message otherwise. */
  handleUpdateRegistrationStatus: (regId: string, targetStatus: string, reason?: string) => Promise<void>;
  pageState: PageState;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  statusFilter: string;
  onStatusFilterChange: (status: string) => void;
  /** Signed-in staff role: decides whether document approval controls are shown in the detail dialogue. */
  role?: string | null;
}

/** Quick filter: registrations whose documents are being reviewed. */
const DOCUMENT_REVIEW_STATUS = 'DOCUMENT_REVIEW';

export default function RegistrationsTab({
  registrations,
  isLoadingRegistrations,
  loadRegistrations,
  handleUpdateRegistrationStatus,
  pageState,
  onPageChange,
  onPageSizeChange,
  statusFilter,
  onStatusFilterChange,
  role
}: RegistrationsTabProps) {
  const [detailId, setDetailId] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminRegistration | null>(null);
  const [targetStatus, setTargetStatus] = useState('');
  const [reason, setReason] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const openDialog = (reg: AdminRegistration) => {
    setSelected(reg);
    setTargetStatus(nextRegistrationStatuses(reg.status)[0] ?? '');
    setReason('');
    setDialogError(null);
  };

  const closeDialog = () => {
    if (!isSaving) setSelected(null);
  };

  const reasonRequired = REASON_REQUIRED_STATUSES.includes(targetStatus);
  const label = (reg: AdminRegistration) => reg.registrationCode || reg.id.slice(0, 8);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !targetStatus) return;
    if (reasonRequired && !reason.trim()) {
      setDialogError('Please record the reason for this decision. It is kept in the audit log.');
      return;
    }
    setIsSaving(true);
    setDialogError(null);
    try {
      await handleUpdateRegistrationStatus(selected.id, targetStatus, reason.trim() || undefined);
      setNotice(`Registration ${label(selected)} has been moved to ${statusLabel(targetStatus)}.`);
      setSelected(null);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'The status could not be changed.');
    } finally {
      setIsSaving(false);
    }
  };

  const showSkeleton = isLoadingRegistrations && registrations.length === 0;
  const options = selected ? nextRegistrationStatuses(selected.status) : [];

  return (
    <div className="space-y-6">
      {/* Captains blocked by email verification: their teams cannot register yet */}
      <AwaitingVerificationPanel />
    <div className="bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-black text-white tracking-tight">Team Registrations</h2>
          <p className="text-xs text-slate-400">
            Review each registration and record its next status. Only the transitions permitted by the registration process are offered.
          </p>
        </div>
        <button
          type="button"
          onClick={loadRegistrations}
          disabled={isLoadingRegistrations}
          className="px-3 py-1.5 bg-[#182035] hover:bg-slate-800 border border-slate-700 text-xs text-slate-300 rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-60"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoadingRegistrations ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </div>

      <Notice tone="success" message={notice} onDismiss={() => setNotice(null)} />

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor="registrations-status-filter" className="text-slate-300 font-bold">
          Status
        </label>
        <select
          id="registrations-status-filter"
          value={statusFilter}
          onChange={(e) => onStatusFilterChange(e.target.value)}
          className="bg-[#182035] border border-slate-700 rounded-lg px-2 py-1.5 text-white"
        >
          <option value="">All Statuses</option>
          {REGISTRATION_STATUSES.map((status) => (
            <option key={status} value={status}>
              {statusLabel(status)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => onStatusFilterChange(statusFilter === DOCUMENT_REVIEW_STATUS ? '' : DOCUMENT_REVIEW_STATUS)}
          aria-pressed={statusFilter === DOCUMENT_REVIEW_STATUS}
          className={`px-2.5 py-1.5 rounded-lg border font-bold transition-colors ${
            statusFilter === DOCUMENT_REVIEW_STATUS
              ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
              : 'bg-[#182035] text-slate-300 border-slate-700 hover:bg-slate-800'
          }`}
        >
          Document Review only
        </button>
      </div>

      {isLoadingRegistrations && <LoadingAnnouncement label="Loading registrations." />}

      {!isLoadingRegistrations && registrations.length === 0 ? (
        <div className="p-8 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-xl">
          {statusFilter
            ? 'No registrations have the selected status.'
            : 'No registrations have been received. Registrations submitted on the public site will appear here.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 font-mono text-[10px] uppercase">
                <th scope="col" className="py-3 px-3">Code</th>
                <th scope="col" className="py-3 px-3">Team</th>
                <th scope="col" className="py-3 px-3">Category</th>
                <th scope="col" className="py-3 px-3">Status</th>
                <th scope="col" className="py-3 px-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className={`divide-y divide-slate-800/60 font-mono transition-opacity ${isLoadingRegistrations && !showSkeleton ? 'opacity-60' : ''}`}>
              {showSkeleton && <SkeletonRows columns={5} rows={6} />}
              {registrations.map((reg, index) => {
                const next = nextRegistrationStatuses(reg.status);
                const docsPending = pendingDocumentCount(reg);
                return (
                  <MotionTr key={reg.id} {...staggerProps(index)} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 px-3 font-bold text-white whitespace-nowrap">{label(reg)}</td>
                    <td className="py-3 px-3">{reg.team?.name || 'Team name not provided'}</td>
                    <td className="py-3 px-3">{reg.category?.name || 'Category not specified'}</td>
                    <td className="py-3 px-3">
                      <span className={`px-2 py-0.5 rounded border text-[10px] whitespace-nowrap ${statusBadgeClass(reg.status)}`}>
                        {statusLabel(reg.status)}
                      </span>
                      {docsPending > 0 && (
                        <span
                          className="ml-1.5 px-2 py-0.5 rounded border text-[10px] whitespace-nowrap bg-amber-500/15 text-amber-300 border-amber-500/30"
                          data-testid="docs-pending"
                        >
                          Docs pending: {docsPending}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-right">
                      <div className="inline-flex flex-wrap justify-end items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setDetailId(reg.id)}
                        aria-label={`View the details and documents of registration ${label(reg)}`}
                        className="px-2.5 py-1 bg-[#182035] hover:bg-slate-800 border border-slate-700 text-slate-200 rounded text-[10px] font-bold whitespace-nowrap transition-colors"
                      >
                        View / Documents
                      </button>
                      {next.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => openDialog(reg)}
                          aria-label={`Change the status of registration ${label(reg)}`}
                          className="px-2.5 py-1 bg-[#22C55E]/15 text-emerald-300 hover:bg-[#22C55E]/25 border border-[#22C55E]/30 rounded text-[10px] font-bold whitespace-nowrap transition-colors"
                        >
                          Change Status
                        </button>
                      ) : (
                        <span className="text-[10px] text-slate-400">Final status</span>
                      )}
                      </div>
                    </td>
                  </MotionTr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        idPrefix="registrations"
        label="Registrations"
        state={pageState}
        isLoading={isLoadingRegistrations}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />

      <RegistrationDetailDialog
        registrationId={detailId}
        role={role}
        onClose={() => setDetailId(null)}
        onChanged={loadRegistrations}
      />

      <Modal
        open={selected !== null}
        title="Change Registration Status"
        description={
          selected
            ? `${label(selected)}, ${selected.team?.name || 'team name not provided'}. Current status: ${statusLabel(selected.status)}.`
            : undefined
        }
        onClose={closeDialog}
        busy={isSaving}
      >
        <form onSubmit={submit} className="space-y-4 text-xs">
          <Notice tone="error" message={dialogError} />
          <div>
            <label htmlFor="registration-target-status" className="block font-bold text-slate-300 mb-1">
              New Status
            </label>
            <select
              id="registration-target-status"
              value={targetStatus}
              onChange={(e) => {
                setTargetStatus(e.target.value);
                setDialogError(null);
              }}
              data-autofocus
              className="w-full bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-white"
            >
              {options.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="flex justify-between items-baseline mb-1">
              <label htmlFor="registration-reason" className="font-bold text-slate-300">
                Reason {reasonRequired ? '(required)' : '(optional)'}
              </label>
              <span className="text-[10px] font-mono text-slate-400">
                {reason.length} / {REASON_MAX} characters
              </span>
            </div>
            <textarea
              id="registration-reason"
              rows={3}
              maxLength={REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required={reasonRequired}
              className="w-full bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#22C55E]"
            />
            <p className="text-[10px] text-slate-400 mt-1">The reason is recorded in the audit log with this change.</p>
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={closeDialog} disabled={isSaving} className={BUTTON_SECONDARY}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving || !targetStatus}
              className={NEGATIVE_STATUSES.includes(targetStatus) ? BUTTON_DANGER : BUTTON_PRIMARY}
            >
              {isSaving ? 'Saving…' : `Move to ${statusLabel(targetStatus)}`}
            </button>
          </div>
        </form>
      </Modal>
    </div>
    </div>
  );
}
