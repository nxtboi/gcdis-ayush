'use client';

import React, { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FileText, UploadCloud, Loader2, X } from 'lucide-react';
import { fetchApi } from '../../../lib/api-client';
import { formatDate, reviewStatusClass, reviewStatusLabel, type RegistrationDocument, type TeamInfo } from './types';
import { DURATION, EASE_OUT, FadeIn, MotionButton, Stagger, StaggerListItem } from './motion';

/** Document types accepted by POST /registrations/:id/documents (DocumentType in @gcdis/shared). */
export const DOCUMENT_TYPES: { value: string; label: string }[] = [
  { value: 'INSTITUTION_NOC', label: 'Institutional approval letter (NOC)' },
  { value: 'INSURANCE', label: 'Insurance certificate' },
  { value: 'TECH_PASSPORT', label: 'Drone technical passport' },
  { value: 'GOVT_ID', label: 'Government-issued identity document' },
  { value: 'OTHER', label: 'Other supporting document' }
];

/** Mirrors the API upload rules for the DOCUMENT purpose (magic-byte checked server-side). */
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp';
const ALLOWED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];
const MAX_SIZE_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_FILES_TEXT = 'Accepted formats: PDF, PNG, JPEG or WebP, up to 10 MB per file.';

interface UploadResponse {
  assetId: string;
  fileName: string;
}

function documentLabel(type: string): string {
  return DOCUMENT_TYPES.find((t) => t.value === type)?.label ?? type.replace(/_/g, ' ');
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The upload validator rejects files whose content does not match an accepted format with a technical message;
 * present it in plain language.
 */
function describeUploadError(message: string): string {
  if (/magic-byte|disguised|unsupported format|file content/i.test(message)) {
    return `The file content does not match an accepted format. ${ACCEPTED_FILES_TEXT}`;
  }
  if (/exceeds maximum|too large/i.test(message)) {
    return 'The file is larger than 10 MB. Please reduce the file size and try again.';
  }
  return message;
}

/** Documents linked to the registration, with their review status. */
export function DocumentList({ documents }: { documents: RegistrationDocument[] }) {
  if (documents.length === 0) {
    return (
      <div className="bg-slate-50 border border-slate-200 p-8 rounded-xl text-center space-y-2">
        <FileText className="w-8 h-8 text-slate-400 mx-auto" aria-hidden="true" />
        <div className="text-xs font-bold text-slate-700">No Documents Received</div>
        <p className="text-[11px] text-slate-500">
          Your institutional approval letter, drone technical documentation and other required documents will be listed here once
          uploaded.
        </p>
      </div>
    );
  }
  return (
    <Stagger stagger={0.04}>
      <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl" aria-label="Submitted documents">
        {documents.map((doc) => (
          <StaggerListItem key={doc.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-4">
            <div className="flex items-start gap-3 min-w-0">
              <FileText className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="min-w-0">
                <div className="text-xs font-bold text-slate-900">{documentLabel(doc.type)}</div>
                <div className="text-[11px] text-slate-500 font-mono truncate">
                  {doc.fileName || 'Uploaded file'}
                  {doc.uploadedAt ? ` • ${formatDate(doc.uploadedAt)}` : ''}
                </div>
                {doc.feedback &&
                  (String(doc.status).toUpperCase() === 'REJECTED' ? (
                    <div className="text-[11px] text-rose-700 font-semibold mt-0.5" data-testid="document-feedback">
                      Reason for rejection: {doc.feedback} Please upload a corrected document below.
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-600 font-semibold mt-0.5" data-testid="document-feedback">
                      Reviewer&apos;s note: {doc.feedback}
                    </div>
                  ))}
              </div>
            </div>
            <span
              className={`self-start sm:self-center inline-block whitespace-nowrap border text-[10px] font-mono font-bold px-2 py-0.5 rounded ${reviewStatusClass(doc.status)}`}
            >
              {doc.status === 'PENDING' ? 'PENDING REVIEW' : reviewStatusLabel(doc.status).toUpperCase()}
            </span>
          </StaggerListItem>
        ))}
      </ul>
    </Stagger>
  );
}

interface UploadsTabProps {
  teamInfo: TeamInfo;
  documents: RegistrationDocument[];
  /** Reload the registration after a document has been linked. */
  onUploaded: () => void | Promise<void>;
  onGoToOverview: () => void;
}

export default function UploadsTab({ teamInfo, documents, onUploaded, onGoToOverview }: UploadsTabProps) {
  const [docType, setDocType] = useState(DOCUMENT_TYPES[0].value);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'linking'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const registrationId = teamInfo.teamId;
  const busy = phase !== 'idle';

  const clearFile = () => {
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const selectFile = (candidate: File | null | undefined) => {
    setError(null);
    setMessage(null);
    if (!candidate) {
      clearFile();
      return;
    }
    const ext = candidate.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      clearFile();
      setError(`"${candidate.name}" is not an accepted file type. ${ACCEPTED_FILES_TEXT}`);
      return;
    }
    if (candidate.size > MAX_SIZE_BYTES) {
      clearFile();
      setError(`"${candidate.name}" is larger than 10 MB. Please reduce the file size and try again.`);
      return;
    }
    if (candidate.size === 0) {
      clearFile();
      setError(`"${candidate.name}" is empty. Please choose another file.`);
      return;
    }
    setFile(candidate);
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !registrationId || busy) return;
    setError(null);
    setMessage(null);
    try {
      setPhase('uploading');
      const form = new FormData();
      form.append('purpose', 'DOCUMENT');
      form.append('file', file, file.name);
      const uploaded = await fetchApi<UploadResponse>('/uploads/stream', {
        method: 'POST',
        body: form
      });

      setPhase('linking');
      await fetchApi(`/registrations/${encodeURIComponent(registrationId)}/documents`, {
        method: 'POST',
        body: JSON.stringify({
          type: docType,
          assetId: uploaded.assetId,
          fileName: uploaded.fileName || file.name
        })
      });

      setMessage(`${documentLabel(docType)} received. It is now awaiting review by the GCDIS Secretariat.`);
      clearFile();
      await onUploaded();
    } catch (err) {
      const reason = err instanceof Error && err.message ? describeUploadError(err.message) : 'The request failed.';
      setError(`The document could not be uploaded. ${reason}`);
    } finally {
      setPhase('idle');
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="bg-white border border-slate-200/80 rounded-2xl p-6 sm:p-8 shadow-sm space-y-6">
        <div>
          <h2 className="text-base font-black text-slate-900 uppercase">Required Documents</h2>
          <p className="text-xs text-slate-500 font-medium">
            Submit endorsement letters, insurance certificates and technical documentation for review by the GCDIS Secretariat.
          </p>
        </div>

        <DocumentList documents={documents} />

        {!registrationId ? (
          <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs font-semibold text-amber-800">
            Documents may be uploaded once your team registration has been submitted.{' '}
            <button type="button" onClick={onGoToOverview} className="font-black underline underline-offset-2">
              Complete team registration
            </button>
          </div>
        ) : (
          <form onSubmit={handleUpload} className="space-y-4">
            <div>
              <label htmlFor="upload-doc-type" className="block text-xs font-bold text-slate-700 mb-1">
                Document Type
              </label>
              <select
                id="upload-doc-type"
                value={docType}
                disabled={busy}
                onChange={(e) => setDocType(e.target.value)}
                className="w-full sm:w-96 p-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 transition-[border-color,box-shadow] duration-200 focus:outline-none focus:border-[#15803D] focus:ring-4 focus:ring-[#22C55E]/15"
              >
                {DOCUMENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Upload Dropzone */}
            <div
              onDragEnter={(e) => {
                e.preventDefault();
                if (!busy) setDragOver(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (!busy && !dragOver) setDragOver(true);
              }}
              onDragLeave={(e) => {
                // Ignore leave events fired when the pointer moves onto a child element of the dropzone.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (!busy) selectFile(e.dataTransfer.files?.[0]);
              }}
              className={`relative overflow-hidden border-2 border-dashed rounded-2xl p-6 sm:p-8 text-center space-y-3 transition-colors duration-200 focus-within:border-[#22C55E] focus-within:ring-4 focus-within:ring-[#22C55E]/15 ${
                dragOver ? 'border-[#22C55E] bg-[#DCFCE7]/40' : 'border-slate-200 bg-slate-50/50 hover:border-[#22C55E]'
              }`}
            >
              <motion.div
                animate={{ y: dragOver ? -3 : 0 }}
                transition={{ duration: DURATION.fast, ease: EASE_OUT }}
                className="mx-auto w-fit"
              >
                <UploadCloud className="w-8 h-8 text-[#15803D]" aria-hidden="true" />
              </motion.div>
              <div>
                <label htmlFor="upload-file" className="text-xs font-bold text-slate-800 cursor-pointer">
                  Drag and drop a file here, or <span className="text-[#15803D] underline underline-offset-2">select a file</span>
                </label>
                <input
                  ref={inputRef}
                  id="upload-file"
                  type="file"
                  accept={ACCEPT}
                  disabled={busy}
                  aria-describedby="upload-help"
                  onChange={(e) => selectFile(e.target.files?.[0])}
                  className="sr-only"
                />
                <div id="upload-help" className="text-[11px] text-slate-500 mt-0.5">
                  {ACCEPTED_FILES_TEXT}
                </div>
              </div>
              <AnimatePresence initial={false}>
                {file && (
                  <motion.div
                    key="selected-file"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: DURATION.fast }}
                    className="mx-auto flex w-fit max-w-full items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-mono text-slate-700"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                    <span className="truncate">
                      {file.name} ({formatSize(file.size)})
                    </span>
                    {!busy && (
                      <button
                        type="button"
                        onClick={clearFile}
                        aria-label={`Remove ${file.name}`}
                        className="rounded-full p-0.5 text-slate-400 transition-colors hover:text-slate-700"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
              <MotionButton
                type="submit"
                disabled={!file || busy}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#15803D] enabled:hover:bg-[#166534] disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-black uppercase transition-colors shadow-sm"
              >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                <span>
                  {phase === 'uploading' ? 'Uploading…' : phase === 'linking' ? 'Linking to registration…' : 'Upload Document'}
                </span>
              </MotionButton>

              {/* Indeterminate progress indicator while the upload is in flight (transform only: no layout shift) */}
              {busy && (
                <div className="absolute inset-x-0 bottom-0 h-1 overflow-hidden bg-[#DCFCE7]" aria-hidden="true">
                  <motion.div
                    className="h-full w-1/3 bg-[#22C55E]"
                    initial={{ x: '-100%' }}
                    animate={{ x: '300%' }}
                    transition={{
                      duration: 1.2,
                      ease: 'easeInOut',
                      repeat: Infinity
                    }}
                  />
                </div>
              )}
            </div>

            <div aria-live="polite">
              {error && (
                <FadeIn
                  role="alert"
                  className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-[11px] font-semibold text-rose-700"
                >
                  {error}
                </FadeIn>
              )}
              {message && (
                <FadeIn
                  role="status"
                  className="rounded-xl border border-[#86EFAC] bg-[#DCFCE7]/60 p-3 text-[11px] font-semibold text-[#15803D]"
                >
                  {message}
                </FadeIn>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
