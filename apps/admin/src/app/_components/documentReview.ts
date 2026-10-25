/**
 * Team document review: API calls and rules shared by the registration detail dialogue and the
 * registrations list. Kept free of React so the request shapes can be unit tested.
 */
import { adminFetch, resolveApiAssetUrl } from '../../lib/api-client';
import type { AdminRegistration } from './types';

/** Mirrors DOCUMENT_FEEDBACK_MAX_LENGTH in apps/api/src/registrations/dto/verify-document.dto.ts. */
export const DOCUMENT_FEEDBACK_MAX = 1000;

export type DocumentDecision = 'VERIFIED' | 'REJECTED';

/** Document types accepted by the API (DocumentType in @gcdis/shared), with formal names. */
export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  INSTITUTION_NOC: 'Institutional Approval Letter (NOC)',
  INSURANCE: 'Insurance Certificate',
  TECH_PASSPORT: 'Drone Technical Passport',
  GOVT_ID: 'Government-Issued Identity Document',
  OTHER: 'Other Supporting Document'
};

export function documentTypeLabel(type?: string | null): string {
  if (!type) return 'Document';
  return DOCUMENT_TYPE_LABELS[type] ?? type.replace(/_/g, ' ');
}

/** Only administrators record document decisions (PATCH /registrations/:id/documents/:docId); inspectors view only. */
export function canDecideDocuments(role?: string | null): boolean {
  return role === 'SUPER_ADMIN' || role === 'EVENT_ADMIN';
}

/** Staff who may open team files through a signed URL (GET /uploads/signed-url/:assetId). */
export function canViewDocuments(role?: string | null): boolean {
  return role === 'SUPER_ADMIN' || role === 'EVENT_ADMIN' || role === 'INSPECTOR';
}

/** Number of documents on a registration that still await review. */
export function pendingDocumentCount(reg: Pick<AdminRegistration, 'documents'>): number {
  return Array.isArray(reg.documents) ? reg.documents.filter((d) => String(d.status).toUpperCase() === 'PENDING').length : 0;
}

export function documentStatusClass(status?: string | null): string {
  const s = String(status ?? '').toUpperCase();
  if (s === 'VERIFIED' || s === 'APPROVED') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
  if (s === 'REJECTED') return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
  return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
}

/** Returns the formal error for an invalid decision, or null when it may be sent. */
export function decisionError(decision: DocumentDecision, feedback: string): string | null {
  const trimmed = feedback.trim();
  if (decision === 'REJECTED' && !trimmed) {
    return 'Please give the reason for rejecting this document. The team sees it and can upload a corrected file.';
  }
  if (trimmed.length > DOCUMENT_FEEDBACK_MAX) {
    return `The feedback must not exceed ${DOCUMENT_FEEDBACK_MAX} characters.`;
  }
  return null;
}

/**
 * PATCH /registrations/:id/documents/:docId (SUPER_ADMIN / EVENT_ADMIN, CsrfGuard). The JSON body and the
 * X-Requested-With header satisfy the API's anti-CSRF check. The feedback is always sent, so approving a
 * document that was rejected earlier clears the old rejection note shown to the team.
 */
export async function submitDocumentDecision(
  registrationId: string,
  documentId: string,
  decision: DocumentDecision,
  feedback: string
): Promise<unknown> {
  const error = decisionError(decision, feedback);
  if (error) throw new Error(error);
  return adminFetch(`/registrations/${encodeURIComponent(registrationId)}/documents/${encodeURIComponent(documentId)}`, {
    method: 'PATCH',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ status: decision, feedback: feedback.trim() })
  });
}

/**
 * Requests a fresh five-minute signed URL for a stored upload and returns its absolute address.
 * The URL carries an access token: it is kept in memory only and never logged or stored.
 */
export async function fetchSignedFileUrl(assetId: string): Promise<string> {
  const data = await adminFetch<{ url?: string }>(`/uploads/signed-url/${encodeURIComponent(assetId)}`);
  if (!data || typeof data.url !== 'string' || !data.url) {
    throw new Error('The server did not return an address for this file.');
  }
  return resolveApiAssetUrl(data.url);
}

/** Opens an address in a new tab without giving the opened page access to the console window. */
export function openInNewTab(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function isImageMime(mimeType?: string | null): boolean {
  return typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/');
}
