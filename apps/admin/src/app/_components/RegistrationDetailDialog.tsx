'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, FileText, RefreshCw } from 'lucide-react';
import { adminFetch } from '../../lib/api-client';
import { Modal, BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY } from './Modal';
import { Notice, Skeleton } from './motion';
import ApiImage from './ApiImage';
import { notifyRegistrationsChanged } from './AwaitingReviewBadge';
import {
  DOCUMENT_FEEDBACK_MAX,
  canDecideDocuments,
  decisionError,
  documentStatusClass,
  documentTypeLabel,
  fetchSignedFileUrl,
  isImageMime,
  openInNewTab,
  pendingDocumentCount,
  submitDocumentDecision,
  type DocumentDecision
} from './documentReview';
import {
  formatDateTime,
  formatInr,
  roleLabel,
  statusLabel,
  type RegistrationDetail,
  type RegistrationDocument,
  type RegistrationPayment
} from './types';

interface RegistrationDetailDialogProps {
  /** Registration to show; null closes the dialogue. */
  registrationId: string | null;
  /** Signed-in staff role: only SUPER_ADMIN and EVENT_ADMIN may approve or reject documents. */
  role?: string | null;
  onClose: () => void;
  /** Called after a document decision so the caller can reload its list. */
  onChanged?: () => void;
}

const SECTION = 'border border-slate-800 rounded-xl p-4 space-y-3';
const SECTION_TITLE = 'text-[11px] font-black uppercase tracking-wider text-slate-300';
const SMALL_BUTTON =
  'px-2.5 py-1 rounded border text-[10px] font-bold whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const VIEW_BUTTON = `${SMALL_BUTTON} bg-[#182035] hover:bg-slate-800 border-slate-700 text-slate-200`;
const APPROVE_BUTTON = `${SMALL_BUTTON} bg-[#22C55E]/15 text-emerald-300 hover:bg-[#22C55E]/25 border-[#22C55E]/30`;
const REJECT_BUTTON = `${SMALL_BUTTON} bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 border-rose-500/30`;

function Field({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-mono uppercase text-slate-400">{label}</dt>
      <dd className="text-xs text-white break-words">{value || '—'}</dd>
    </div>
  );
}

function latestPayment(payments?: RegistrationPayment[]): RegistrationPayment | null {
  if (!Array.isArray(payments) || payments.length === 0) return null;
  const success = payments.find((p) => p.status === 'SUCCESS');
  if (success) return success;
  return [...payments].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
}

function paymentClass(status?: string | null): string {
  if (status === 'SUCCESS') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
  if (status === 'FAILED' || status === 'REFUNDED') return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
  return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
}

export interface RegistrationDetailViewProps {
  detail: RegistrationDetail;
  /** SUPER_ADMIN / EVENT_ADMIN: approval controls are shown; otherwise the documents are read only. */
  canDecide: boolean;
  isLoading?: boolean;
  isSaving?: boolean;
  /** Key of the file whose signed URL is being requested ("doc:<id>" or "member:<id>"). */
  openingId?: string | null;
  opened?: { id: string; url: string; image: boolean } | null;
  decision?: { docId: string; status: DocumentDecision } | null;
  feedback?: string;
  decisionMessage?: string | null;
  onRefresh: () => void;
  onViewFile: (key: string, assetId: string | null | undefined, mimeType?: string | null) => void;
  onStartDecision: (doc: RegistrationDocument, status: DocumentDecision) => void;
  onCancelDecision: () => void;
  onFeedbackChange: (value: string) => void;
  onSubmitDecision: (e: React.FormEvent) => void;
}

/** Presentational part of the registration detail dialogue (no requests), rendered once the detail has loaded. */
export function RegistrationDetailView({
  detail,
  canDecide,
  isLoading = false,
  isSaving = false,
  openingId = null,
  opened = null,
  decision = null,
  feedback = '',
  decisionMessage = null,
  onRefresh,
  onViewFile,
  onStartDecision,
  onCancelDecision,
  onFeedbackChange,
  onSubmitDecision
}: RegistrationDetailViewProps) {
  const team = detail.team;
  const members = Array.isArray(team?.members) ? team!.members : [];
  const documents = Array.isArray(detail.documents) ? detail.documents : [];
  const payment = latestPayment(detail.payments);
  const pending = pendingDocumentCount(detail);

  const fallbackLink = (key: string) =>
    opened?.id === key ? (
      <div className="space-y-2">
        <a
          href={opened.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-300 underline underline-offset-2"
        >
          <ExternalLink className="w-3 h-3" aria-hidden="true" />
          Open the file again (link valid for a few minutes)
        </a>
        {opened.image && (
          <ApiImage
            src={opened.url}
            alt="Preview of the uploaded file"
            className="max-h-64 rounded-lg border border-slate-700 bg-black/30 object-contain"
          />
        )}
      </div>
    ) : null;

  return (
    <>
      <section className={SECTION} aria-labelledby="reg-detail-summary">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="reg-detail-summary" className={SECTION_TITLE}>
            Team Summary
          </h3>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading || isSaving}
            className={VIEW_BUTTON}
          >
            <RefreshCw className={`inline w-3 h-3 mr-1 ${isLoading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
            Refresh
          </button>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <Field label="Team" value={team?.name} />
          <Field label="Team Code" value={team?.code} />
          <Field label="Category" value={detail.category?.name} />
          <Field label="Institution" value={team?.institutionName} />
          <Field label="City" value={team?.city} />
          <Field
            label="Captain"
            value={
              team?.captain ? (
                <>
                  {team.captain.fullName || 'Name not provided'}
                  {team.captain.email && <span className="block font-mono text-slate-300">{team.captain.email}</span>}
                </>
              ) : null
            }
          />
          <Field label="Registration Code" value={<span className="font-mono">{detail.registrationCode}</span>} />
          <Field
            label="Registration Status"
            value={
              <span className="px-2 py-0.5 rounded border text-[10px] bg-slate-800 text-slate-200 border-slate-700">
                {statusLabel(detail.status)}
              </span>
            }
          />
          <Field
            label="Payment"
            value={
              payment ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span className={`px-2 py-0.5 rounded border text-[10px] ${paymentClass(payment.status)}`} data-testid="payment-status">
                    {statusLabel(payment.status)}
                  </span>
                  <span className="font-mono">{formatInr(payment.amount)}</span>
                  {payment.paidAt && <span className="text-slate-400">{formatDateTime(payment.paidAt)}</span>}
                </span>
              ) : (
                <span className="text-slate-400">No payment recorded</span>
              )
            }
          />
        </dl>
      </section>

      <section className={SECTION} aria-labelledby="reg-detail-roster">
        <h3 id="reg-detail-roster" className={SECTION_TITLE}>
          Roster ({members.length})
        </h3>
        {members.length === 0 ? (
          <p className="text-slate-400">No team members are listed.</p>
        ) : (
          <ul className="divide-y divide-slate-800/60" aria-label="Team members">
            {members.map((member) => {
              const key = `member:${member.id}`;
              return (
                <li key={member.id} className="py-2 flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-bold text-white">{member.fullName || 'Name not provided'}</div>
                    <div className="text-slate-400">
                      {roleLabel(member.memberRole)}
                      {member.email && <span className="font-mono text-slate-300"> · {member.email}</span>}
                    </div>
                    {fallbackLink(key)}
                  </div>
                  {member.idProofUrl ? (
                    <button
                      type="button"
                      onClick={() => onViewFile(key, member.idProofAssetId, member.idProofMimeType)}
                      disabled={openingId === key}
                      aria-label={`View the ID proof of ${member.fullName || 'this member'} in a new tab`}
                      className={`${VIEW_BUTTON} self-start`}
                    >
                      {openingId === key ? 'Opening…' : 'ID proof'}
                    </button>
                  ) : (
                    <span className="text-[10px] text-slate-400 self-start">No ID proof</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={SECTION} aria-labelledby="reg-detail-documents">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="reg-detail-documents" className={SECTION_TITLE}>
            Documents ({documents.length})
          </h3>
          {pending > 0 && (
            <span className="px-2 py-0.5 rounded border text-[10px] font-bold bg-amber-500/15 text-amber-300 border-amber-500/30">
              {pending} awaiting review
            </span>
          )}
        </div>
        {!canDecide && (
          <p className="text-slate-400">You may view these documents. Approval and rejection are recorded by the Event Administrators.</p>
        )}
        {documents.length === 0 ? (
          <p className="text-slate-400">The team has not uploaded any documents.</p>
        ) : (
          <ul className="divide-y divide-slate-800/60" aria-label="Uploaded documents">
            {documents.map((doc) => {
              const key = `doc:${doc.id}`;
              const deciding = decision?.docId === doc.id ? decision : null;
              const status = String(doc.status || 'PENDING').toUpperCase();
              return (
                <li key={doc.id} className="py-3 space-y-2" data-testid="document-row">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <FileText className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
                      <div className="min-w-0">
                        <div className="font-bold text-white">{documentTypeLabel(doc.type)}</div>
                        <div className="font-mono text-slate-400 truncate">
                          {doc.fileName || 'File name not recorded'} · {formatDateTime(doc.uploadedAt)}
                        </div>
                        {doc.feedback && <div className="text-slate-300 mt-0.5">Feedback: {doc.feedback}</div>}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end shrink-0">
                      <span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${documentStatusClass(status)}`}>
                        {status === 'APPROVED' ? 'VERIFIED' : status}
                      </span>
                      <button
                        type="button"
                        onClick={() => onViewFile(key, doc.assetId, doc.mimeType)}
                        disabled={openingId === key}
                        aria-label={`View ${documentTypeLabel(doc.type)} in a new tab`}
                        className={VIEW_BUTTON}
                      >
                        {openingId === key ? 'Opening…' : 'View'}
                      </button>
                      {canDecide && (
                        <>
                          <button
                            type="button"
                            onClick={() => onStartDecision(doc, 'VERIFIED')}
                            disabled={isSaving || status === 'VERIFIED'}
                            className={APPROVE_BUTTON}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => onStartDecision(doc, 'REJECTED')}
                            disabled={isSaving}
                            className={REJECT_BUTTON}
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {fallbackLink(key)}
                  {canDecide && deciding && (
                    <form onSubmit={onSubmitDecision} className="bg-[#0B0F19] border border-slate-800 rounded-xl p-3 space-y-2">
                      <div className="flex justify-between items-baseline">
                        <label htmlFor={`doc-feedback-${doc.id}`} className="font-bold text-slate-300">
                          {deciding.status === 'REJECTED'
                            ? 'Reason for rejection (required, shown to the team)'
                            : 'Note to the team (optional)'}
                        </label>
                        <span className="text-[10px] font-mono text-slate-400">
                          {feedback.length} / {DOCUMENT_FEEDBACK_MAX} characters
                        </span>
                      </div>
                      <textarea
                        id={`doc-feedback-${doc.id}`}
                        rows={3}
                        maxLength={DOCUMENT_FEEDBACK_MAX}
                        value={feedback}
                        onChange={(e) => onFeedbackChange(e.target.value)}
                        required={deciding.status === 'REJECTED'}
                        aria-invalid={decisionMessage ? true : undefined}
                        autoFocus
                        className="w-full bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#22C55E]"
                      />
                      <Notice tone="error" message={decisionMessage} />
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={onCancelDecision} disabled={isSaving} className={BUTTON_SECONDARY}>
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={isSaving || (deciding.status === 'REJECTED' && !feedback.trim())}
                          className={deciding.status === 'REJECTED' ? BUTTON_DANGER : BUTTON_PRIMARY}
                        >
                          {isSaving ? 'Saving…' : deciding.status === 'REJECTED' ? 'Confirm Rejection' : 'Confirm Approval'}
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * Registration detail for staff: team summary, roster with ID proofs, uploaded documents with their review
 * status, and payment status. Files open through a fresh signed URL in a new tab. Administrators approve or
 * reject each document; a rejection requires feedback, which the team sees in the portal.
 */
export default function RegistrationDetailDialog({ registrationId, role, onClose, onChanged }: RegistrationDetailDialogProps) {
  const [detail, setDetail] = useState<RegistrationDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  /** Address of the file opened last, as a fallback link when the browser blocks the new tab. In memory only. */
  const [opened, setOpened] = useState<{ id: string; url: string; image: boolean } | null>(null);
  const [decision, setDecision] = useState<{ docId: string; status: DocumentDecision } | null>(null);
  const [feedback, setFeedback] = useState('');
  const [decisionMessage, setDecisionMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const canDecide = canDecideDocuments(role);

  const load = useCallback(async (id: string) => {
    setIsLoading(true);
    setLoadError(null);
    try {
      setDetail(await adminFetch<RegistrationDetail>(`/registrations/${encodeURIComponent(id)}`));
    } catch (err) {
      setLoadError(`The registration could not be loaded. ${err instanceof Error ? err.message : 'Please try again.'}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    setDetail(null);
    setNotice(null);
    setActionError(null);
    setOpened(null);
    setDecision(null);
    setFeedback('');
    setDecisionMessage(null);
    if (registrationId) void load(registrationId);
  }, [registrationId, load]);

  // A signed URL is valid for five minutes: drop the fallback link before it expires
  useEffect(() => {
    if (!opened) return;
    const timer = window.setTimeout(() => setOpened(null), 4 * 60 * 1000);
    return () => window.clearTimeout(timer);
  }, [opened]);

  const viewFile = async (key: string, assetId: string | null | undefined, mimeType?: string | null) => {
    setActionError(null);
    if (!assetId) {
      setActionError('This file is not held in the document store and cannot be opened from the console.');
      return;
    }
    setOpeningId(key);
    try {
      const url = await fetchSignedFileUrl(assetId);
      setOpened({ id: key, url, image: isImageMime(mimeType) });
      openInNewTab(url);
    } catch (err) {
      setActionError(`The file could not be opened. ${err instanceof Error ? err.message : 'Please try again.'}`);
    } finally {
      setOpeningId(null);
    }
  };

  const startDecision = (doc: RegistrationDocument, status: DocumentDecision) => {
    setDecision({ docId: doc.id, status });
    setFeedback(status === 'REJECTED' ? doc.feedback ?? '' : '');
    setDecisionMessage(null);
    setNotice(null);
    setActionError(null);
  };

  const submitDecision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!decision || !detail) return;
    const invalid = decisionError(decision.status, feedback);
    if (invalid) {
      setDecisionMessage(invalid);
      return;
    }
    const doc = detail.documents?.find((d) => d.id === decision.docId);
    setIsSaving(true);
    setDecisionMessage(null);
    try {
      await submitDocumentDecision(detail.id, decision.docId, decision.status, feedback);
      setNotice(
        `${documentTypeLabel(doc?.type)} has been ${decision.status === 'VERIFIED' ? 'approved' : 'rejected'}. The team can see the result in the portal.`
      );
      setDecision(null);
      setFeedback('');
      await load(detail.id);
      onChanged?.();
      notifyRegistrationsChanged();
    } catch (err) {
      setDecisionMessage(`The decision could not be recorded. ${err instanceof Error ? err.message : 'Please try again.'}`);
    } finally {
      setIsSaving(false);
    }
  };

  const code = detail?.registrationCode || registrationId?.slice(0, 8) || '';

  return (
    <Modal
      open={registrationId !== null}
      title="Registration Details and Documents"
      description={detail ? `${code}, ${detail.team?.name || 'team name not provided'}.` : 'Loading the registration.'}
      onClose={onClose}
      busy={isSaving}
      size="xl"
    >
      <div className="space-y-4 text-xs" data-testid="registration-detail">
        <Notice tone="error" message={loadError} />
        <Notice tone="success" message={notice} onDismiss={() => setNotice(null)} />
        <Notice tone="error" message={actionError} onDismiss={() => setActionError(null)} />

        {isLoading && !detail && (
          <div className="space-y-3" role="status" aria-label="Loading the registration.">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}

        {detail && (
          <RegistrationDetailView
            detail={detail}
            canDecide={canDecide}
            isLoading={isLoading}
            isSaving={isSaving}
            openingId={openingId}
            opened={opened}
            decision={decision}
            feedback={feedback}
            decisionMessage={decisionMessage}
            onRefresh={() => void load(detail.id)}
            onViewFile={(key, assetId, mimeType) => void viewFile(key, assetId, mimeType)}
            onStartDecision={startDecision}
            onCancelDecision={() => setDecision(null)}
            onFeedbackChange={(value) => {
              setFeedback(value);
              setDecisionMessage(null);
            }}
            onSubmitDecision={submitDecision}
          />
        )}

        <div className="flex justify-end">
          <button type="button" onClick={onClose} disabled={isSaving} className={BUTTON_SECONDARY}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
