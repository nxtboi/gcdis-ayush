export type AdminTab =
  | 'overview'
  | 'cms_hero'
  | 'home_sections'
  | 'site_info'
  | 'sponsors'
  | 'gallery'
  | 'championship_media'
  | 'registrations'
  | 'scrutineering'
  | 'scoring'
  | 'audit'
  | 'users'
  | 'prizes'
  | 'security';

export interface HeroConfig {
  mediaUrl: string;
  mediaType: 'image' | 'video' | 'color';
  focusX: number;
  focusY: number;
  zoom: number;
  overlayColor: string;
  overlayOpacity: number;
  blurPx: number;
  brightnessPct: number;
  parallaxEnabled: boolean;
  mobileCropFocusY: number;
}

export const DEFAULT_HERO_CONFIG: HeroConfig = {
  mediaUrl: '',
  mediaType: 'image',
  focusX: 50,
  focusY: 50,
  zoom: 100,
  overlayColor: '#0b1120',
  overlayOpacity: 0.85,
  blurPx: 0,
  brightnessPct: 100,
  parallaxEnabled: false,
  mobileCropFocusY: 50
};

/** Hero text shown on the public home page; stored at the top level of the hero section `data`. */
export interface HeroText {
  headline: string;
  tagline: string;
  description: string;
  announcementTitle: string;
  announcementDate: string;
  announcementBody: string;
}

export const HERO_TEXT_LIMITS: Record<keyof HeroText, number> = {
  headline: 200,
  tagline: 120,
  description: 600,
  announcementTitle: 160,
  announcementDate: 60,
  announcementBody: 1000
};

export const DEFAULT_HERO_TEXT: HeroText = {
  headline: '',
  tagline: '',
  description: '',
  announcementTitle: '',
  announcementDate: '',
  announcementBody: ''
};

/** Pick the hero text fields from stored section data, coercing to strings within the limits. */
export function heroTextFrom(data: unknown): HeroText {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const result = { ...DEFAULT_HERO_TEXT };
  (Object.keys(HERO_TEXT_LIMITS) as (keyof HeroText)[]).forEach((key) => {
    const value = record[key];
    if (typeof value === 'string') result[key] = value.slice(0, HERO_TEXT_LIMITS[key]);
  });
  return result;
}

/** Pick only the background fields from stored section data (text fields are kept separately). */
export function heroConfigFrom(data: unknown): HeroConfig {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  // Older content nests the background settings under `background`
  const source =
    record.background && typeof record.background === 'object' ? (record.background as Record<string, unknown>) : record;
  const result: HeroConfig = { ...DEFAULT_HERO_CONFIG };
  (Object.keys(DEFAULT_HERO_CONFIG) as (keyof HeroConfig)[]).forEach((key) => {
    const value = source[key];
    if (value !== undefined && value !== null && typeof value === typeof DEFAULT_HERO_CONFIG[key]) {
      (result as unknown as Record<string, unknown>)[key] = value;
    }
  });
  return result;
}

/** Roles that belong on the staff accounts list; team captains are participants, not staff. */
export const STAFF_ROLES = ['SUPER_ADMIN', 'EVENT_ADMIN', 'JUDGE', 'INSPECTOR'] as const;

export function isStaffRole(role?: string | null): boolean {
  return !!role && (STAFF_ROLES as readonly string[]).includes(role);
}

/** Formal role names for display; the API value is kept for requests. */
export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Administrator',
  EVENT_ADMIN: 'Event Administrator',
  JUDGE: 'Judge',
  INSPECTOR: 'Technical Inspector',
  TEAM_CAPTAIN: 'Team Captain'
};

export function roleLabel(role?: string | null): string {
  if (!role) return 'System';
  return ROLE_LABELS[role] ?? statusLabel(role);
}

export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

export interface PageState {
  page: number;
  pageSize: number;
  /** Total number of records, when the API reports it. */
  total: number | null;
  /** Number of rows on the current page (used to detect the last page when no total is reported). */
  count: number;
}

export interface StaffUser {
  id: string;
  email: string;
  fullName?: string;
  role?: string;
  /** Returned by GET /auth/users and /auth/me. */
  isTwoFactorEnabled?: boolean;
  /** Field name used by earlier API responses. */
  twoFactorEnabled?: boolean;
  isActive?: boolean;
  mustChangePassword?: boolean;
}

/** Whether two-factor authentication is enabled, whichever field name the API used. */
export function hasTwoFactor(user: StaffUser): boolean {
  return Boolean(user.isTwoFactorEnabled ?? user.twoFactorEnabled);
}

export interface CreatedStaff {
  email: string;
  tempPassword?: string;
}

export interface ChecklistItem {
  id: string;
  title: string;
  detail?: string;
  status: string;
  isComplete?: boolean;
}

export interface Checklist {
  canGoLive: boolean;
  items: ChecklistItem[];
}

/** Whether a checklist item is complete (older API responses only report the status text). */
export function isChecklistItemComplete(item: ChecklistItem): boolean {
  if (typeof item.isComplete === 'boolean') return item.isComplete;
  return item.status === 'Complete' || item.status === 'Configured';
}

export interface Prize {
  id: string;
  category: string;
  rank?: number;
  title?: string;
  amount?: number;
  currency?: string;
  isConfirmed?: boolean;
  notes?: string | null;
}

export interface PrizePool {
  poolTotal?: number;
  confirmedTotal?: number;
  unallocated?: number;
  unallocatedStatus?: string;
  prizes?: Prize[];
}

export interface ContentVersion {
  id?: string;
  versionNumber: number;
  changeNote?: string | null;
  createdAt?: string;
  publishedBy?: string | null;
}

export interface AdminRegistration {
  id: string;
  registrationCode?: string;
  status: string;
  submittedAt?: string | null;
  team?: { name?: string; institutionName?: string | null } | null;
  category?: { name?: string } | null;
  /** Included by GET /registrations (list) and GET /registrations/:id. */
  documents?: RegistrationDocument[];
}

/** A team document as returned to staff by GET /registrations/:id. */
export interface RegistrationDocument {
  id: string;
  type: string;
  fileName?: string | null;
  status: string;
  feedback?: string | null;
  uploadedAt?: string | null;
  /** Stored upload behind the document, for GET /uploads/signed-url/:assetId (staff detail view only). */
  assetId?: string | null;
  mimeType?: string | null;
}

export interface RegistrationMember {
  id: string;
  fullName?: string | null;
  email?: string | null;
  memberRole?: string | null;
  status?: string | null;
  idProofUrl?: string | null;
  idProofAssetId?: string | null;
  idProofMimeType?: string | null;
}

export interface RegistrationPayment {
  id: string;
  status?: string | null;
  amount?: number | null;
  currency?: string | null;
  createdAt?: string | null;
  paidAt?: string | null;
}

/** GET /registrations/:id for staff: the team with captain and roster, category, documents and payments. */
export interface RegistrationDetail extends AdminRegistration {
  team?: {
    name?: string;
    code?: string | null;
    institutionName?: string | null;
    city?: string | null;
    captain?: { fullName?: string | null; email?: string | null } | null;
    members?: RegistrationMember[];
  } | null;
  category?: { name?: string } | null;
  documents?: RegistrationDocument[];
  payments?: RegistrationPayment[];
}

/**
 * Drone ball limits checked at technical inspection, from the FIDA Dronesoccer Regulations,
 * 5th Revision (1 October 2025), Regulation 2 "Drone Ball": Class 20 = 20 cm ± 1 cm, max. 110 g;
 * Class 40 = 40 cm ± 2 cm, max. 1,100 g (weight during play).
 */
export const FIDA_BALL_LIMITS = {
  D20: { label: 'Class 20 (D20)', minDiameterMm: 190, maxDiameterMm: 210, maxWeightGrams: 110 },
  D40: { label: 'Class 40 (D40)', minDiameterMm: 380, maxDiameterMm: 420, maxWeightGrams: 1100 }
} as const;

export type FidaClass = keyof typeof FIDA_BALL_LIMITS;

/** Resolve the FIDA class from a category name such as "Class 40 (D40) Drone Soccer". */
export function fidaClassOf(categoryName?: string | null): FidaClass {
  return /40/.test(categoryName ?? '') ? 'D40' : 'D20';
}

/** Failsafe response limit: a GCDIS organiser safety check, not a FIDA rulebook requirement. */
export const FAILSAFE_MAX_SECONDS = 0.2;

export interface InspectionRecord {
  id: string;
  status: string;
  inspectedAt?: string;
  diameterMm?: number;
  weightGrams?: number;
  failsafeLatencySec?: number;
  notes?: string | null;
  registration?: {
    registrationCode?: string;
    team?: { name?: string } | null;
    category?: { name?: string } | null;
  } | null;
}

export interface Fixture {
  id: string;
  matchNumber?: number;
  status?: string;
  team1Id?: string;
  team2Id?: string;
  team1Name?: string;
  team2Name?: string;
  team1Score?: number;
  team2Score?: number;
  team1?: { id?: string; name?: string } | null;
  team2?: { id?: string; name?: string } | null;
  arenaName?: string | null;
  stage?: string | null;
  categoryName?: string | null;
}

export interface AuditLog {
  id: string;
  createdAt: string;
  actorEmail?: string | null;
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  ipAddress?: string | null;
}

/** "PAYMENT_PENDING" becomes "Payment Pending" for display; the API value is kept for requests. */
export function statusLabel(status?: string | null): string {
  if (!status) return 'Not Specified';
  return status
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const EM_DASH = '—';

/** "11 Oct 2026, 22:15:04" in the viewer's time zone; an em dash when the value is missing or invalid. */
export function formatDateTime(value?: string | null): string {
  if (!value) return EM_DASH;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

/** "INR 21,000" with Indian digit grouping; an em dash when the amount is missing. */
export function formatInr(amount?: number | null): string {
  return typeof amount === 'number' && Number.isFinite(amount) ? `INR ${amount.toLocaleString('en-IN')}` : EM_DASH;
}

/**
 * Registration status transitions accepted by the API: a mirror of ALLOWED_REGISTRATION_TRANSITIONS in
 * @gcdis/shared, kept here so the console bundle does not include the shared validation schemas.
 * A unit test keeps both tables identical.
 */
export const REGISTRATION_TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ['SUBMITTED', 'WITHDRAWN'],
  SUBMITTED: ['FACULTY_ENDORSED', 'ADMINISTRATIVE_REVIEW', 'REQUIRES_ACTION', 'REJECTED', 'WITHDRAWN'],
  FACULTY_ENDORSED: ['ADMINISTRATIVE_REVIEW', 'REQUIRES_ACTION', 'REJECTED', 'WITHDRAWN'],
  ADMINISTRATIVE_REVIEW: ['PAYMENT_PENDING', 'DOCUMENT_REVIEW', 'REQUIRES_ACTION', 'REJECTED', 'WITHDRAWN'],
  PAYMENT_PENDING: ['PAYMENT_VERIFIED', 'REQUIRES_ACTION', 'CANCELLED', 'WITHDRAWN'],
  PAYMENT_VERIFIED: ['ADMINISTRATIVE_REVIEW', 'DOCUMENT_REVIEW', 'TECHNICAL_SUBMISSION', 'REQUIRES_ACTION', 'REJECTED', 'WITHDRAWN'],
  DOCUMENT_REVIEW: ['TECHNICAL_SUBMISSION', 'REQUIRES_ACTION', 'REJECTED', 'WITHDRAWN'],
  TECHNICAL_SUBMISSION: ['TECHNICAL_INSPECTION', 'REQUIRES_ACTION', 'WITHDRAWN'],
  TECHNICAL_INSPECTION: ['ELIGIBILITY_REVIEW', 'REQUIRES_ACTION', 'REJECTED', 'WITHDRAWN'],
  ELIGIBILITY_REVIEW: ['APPROVED', 'REQUIRES_ACTION', 'REJECTED', 'WITHDRAWN'],
  APPROVED: ['ACCREDITED'],
  ACCREDITED: ['COMPETING'],
  COMPETING: ['ARENA_CLEARED', 'COMPLETED'],
  ARENA_CLEARED: ['COMPLETED'],
  COMPLETED: [],
  REQUIRES_ACTION: ['SUBMITTED', 'DOCUMENT_REVIEW', 'TECHNICAL_SUBMISSION', 'WITHDRAWN'],
  REJECTED: [],
  WITHDRAWN: [],
  CANCELLED: []
};

/** Statuses a staff member may move a registration to from its current status. */
export function nextRegistrationStatuses(status: string): readonly string[] {
  return REGISTRATION_TRANSITIONS[status] ?? [];
}

/** Outcomes that must be explained to the team, so the console requires a recorded reason. */
export const REASON_REQUIRED_STATUSES: readonly string[] = ['REJECTED', 'REQUIRES_ACTION', 'CANCELLED', 'WITHDRAWN'];

/** Match status transitions accepted by the API: a mirror of ALLOWED_MATCH_TRANSITIONS in @gcdis/shared. */
export const MATCH_TRANSITIONS: Record<string, readonly string[]> = {
  SCHEDULED: ['CHECK_IN', 'READY'],
  CHECK_IN: ['READY', 'SCHEDULED'],
  READY: ['LIVE', 'SCHEDULED'],
  LIVE: ['PAUSED', 'COMPLETED'],
  PAUSED: ['LIVE', 'COMPLETED'],
  COMPLETED: ['VERIFIED', 'LIVE'],
  VERIFIED: []
};

/** Score events are accepted only while a match is live or paused. */
export function canScore(status?: string | null): boolean {
  return status === 'LIVE' || status === 'PAUSED';
}
