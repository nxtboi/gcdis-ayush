import { ORG_EMAIL } from '@/lib/site';

export type PortalTab = 'overview' | 'members' | 'mission' | 'documents' | 'uploads' | 'status' | 'doubt';

export interface TeamInfo {
  name: string;
  /** Registration id (used for payments and status); empty until the registration is submitted. */
  teamId: string;
  /** Team record id (used for member management); empty until the team is saved. */
  teamRecordId: string;
  /** Human-readable team code, e.g. GCDIS-2026-T001. */
  teamCode: string;
  /** Human-readable registration code. */
  registrationCode: string;
  categoryId: string;
  /** Roster limit of the team's category (at most 7). */
  maxTeamSize: number;
  category: string;
  institute: string;
  city: string;
  captainEmail: string;
  captainName: string;
  captainMobile: string;
  status: string;
  statusDesc: string;
}

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  /** API memberRole code (CAPTAIN, PILOT, PIT_CREW, COACH, ADVISOR). */
  roleCode: string;
  roleType: 'captain' | 'faculty' | 'member';
  email: string;
  mobile: string;
  status: string;
}

/** Document linked to the registration (POST /registrations/:id/documents). */
export interface RegistrationDocument {
  id: string;
  type: string;
  fileName?: string | null;
  status: string;
  feedback?: string | null;
  uploadedAt?: string;
}

export interface MemberDraft {
  name: string;
  role: string;
  email: string;
  mobile: string;
}

/** Successful registration payment, as returned by the API inside a registration. */
export interface PaidInvoice {
  id: string;
  orderId: string;
  amount: number;
  baseAmount?: number | null;
  gstAmount?: number | null;
  gstRate?: number | null;
  currency: string;
  paidAt?: string | null;
}

export const EMPTY_TEAM: TeamInfo = {
  name: '',
  teamId: '',
  teamRecordId: '',
  teamCode: '',
  registrationCode: '',
  categoryId: '',
  maxTeamSize: 7,
  category: '',
  institute: '',
  city: '',
  captainEmail: '',
  captainName: '',
  captainMobile: '',
  status: 'NOT_SUBMITTED',
  statusDesc: 'Registration not yet submitted'
};

/** Fallback Secretariat email; components read the console-managed value with useSiteInfo(). */
export const SECRETARIAT_EMAIL = ORG_EMAIL;

/** Build a mailto: link (used for actions that have no online API yet). */
export function buildMailto(subject: string, body: string, to: string = SECRETARIAT_EMAIL): string {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function formatInr(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Label for actions that are not yet available online. */
export const NOT_AVAILABLE_LABEL = 'Not yet available';

/** Formal labels for registration statuses (RegistrationStatus in @gcdis/shared). */
export const REGISTRATION_STATUS_LABELS: Record<string, string> = {
  NOT_SUBMITTED: 'Not submitted',
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  FACULTY_ENDORSED: 'Faculty endorsed',
  ADMINISTRATIVE_REVIEW: 'Under administrative review',
  PAYMENT_PENDING: 'Entry fee payment due',
  PAYMENT_VERIFIED: 'Entry fee received',
  DOCUMENT_REVIEW: 'Documents under review',
  TECHNICAL_SUBMISSION: 'Technical submission',
  TECHNICAL_INSPECTION: 'Technical inspection',
  ELIGIBILITY_REVIEW: 'Eligibility review',
  APPROVED: 'Approved',
  ACCREDITED: 'Accredited',
  COMPETING: 'Competing',
  ARENA_CLEARED: 'Arena cleared',
  COMPLETED: 'Completed',
  REQUIRES_ACTION: 'Action required',
  REJECTED: 'Not accepted',
  WITHDRAWN: 'Withdrawn',
  CANCELLED: 'Cancelled'
};

/** Human-readable label for an API status code (falls back to the code in sentence case). */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return REGISTRATION_STATUS_LABELS.NOT_SUBMITTED;
  const known = REGISTRATION_STATUS_LABELS[status.toUpperCase()];
  if (known) return known;
  const words = status.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Statuses that end a registration without competing. */
export const CLOSED_STATUSES = new Set(['REJECTED', 'WITHDRAWN', 'CANCELLED']);

/**
 * Registration stages in which the roster is final and members can no longer be added, edited or removed
 * (POST_APPROVAL_STATUSES in @gcdis/shared; the API enforces the same rule).
 */
export const ROSTER_LOCKED_STATUSES = new Set(['APPROVED', 'ACCREDITED', 'COMPETING', 'ARENA_CLEARED', 'COMPLETED']);

/** Explanation shown on the Add, Edit and Remove actions while the roster is final (the API answers 409 with the same rule). */
export const ROSTER_LOCKED_MESSAGE =
  'The roster is final once the registration has been approved. Please contact the GCDIS Secretariat if a change is required.';

/** Formal labels for team member roles (TeamMemberRole in @gcdis/shared). */
export const MEMBER_ROLE_LABELS: Record<string, string> = {
  CAPTAIN: 'Captain',
  PILOT: 'Pilot',
  PIT_CREW: 'Pit crew',
  COACH: 'Coach',
  ADVISOR: 'Advisor',
  TEAM_MEMBER: 'Team member'
};

export function memberRoleLabel(roleCode: string): string {
  return MEMBER_ROLE_LABELS[roleCode.toUpperCase()] ?? statusLabel(roleCode);
}

/** Labels for member and document review statuses. */
export function reviewStatusLabel(status: string): string {
  switch (status.toUpperCase()) {
    case 'PENDING':
      return 'Pending verification';
    case 'VERIFIED':
    case 'APPROVED':
      return 'Verified';
    case 'REJECTED':
      return 'Rejected';
    default:
      return statusLabel(status);
  }
}

/** Tailwind classes for a review status badge. */
export function reviewStatusClass(status: string): string {
  const s = status.toUpperCase();
  if (s === 'VERIFIED' || s === 'APPROVED' || s === 'ACTIVE') return 'bg-[#DCFCE7] text-[#15803D] border-[#86EFAC]';
  if (s === 'REJECTED') return 'bg-rose-50 text-rose-700 border-rose-200';
  return 'bg-amber-50 text-amber-800 border-amber-200';
}

/** Dates in the Indian English long form, e.g. "11 October 2026". */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}
