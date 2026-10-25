/**
 * The team's journey shown in the portal sidebar, derived only from data the portal already loads
 * (team record, email verification status, roster, registration status and payment). Pure logic (no React or
 * path aliases) so it can be unit-tested.
 */

/** Order of the registration workflow (RegistrationStatus), as in registration-steps.ts. */
const STATUS_RANK: Record<string, number> = {
  DRAFT: 0,
  SUBMITTED: 1,
  FACULTY_ENDORSED: 2,
  ADMINISTRATIVE_REVIEW: 3,
  PAYMENT_PENDING: 4,
  PAYMENT_VERIFIED: 5,
  DOCUMENT_REVIEW: 6,
  TECHNICAL_SUBMISSION: 7,
  TECHNICAL_INSPECTION: 8,
  ELIGIBILITY_REVIEW: 9,
  APPROVED: 10,
  ACCREDITED: 11,
  COMPETING: 12,
  ARENA_CLEARED: 13,
  COMPLETED: 14
};

/** FIDA line-up: five players per team on the field. */
export const JOURNEY_LINE_UP = 5;

/** Subset of PortalTab (types.ts) the journey links to; kept local so this module has no path aliases. */
export type JourneyTab = 'overview' | 'members' | 'documents' | 'status';

export type JourneyState = 'done' | 'current' | 'pending';

export interface JourneyStep {
  id: 'team' | 'email' | 'members' | 'submitted' | 'payment' | 'inspection' | 'approved';
  label: string;
  /** Short status line for the tooltip / screen readers. */
  detail: string;
  state: JourneyState;
  /** Dashboard section that deals with this step (a PortalTab id). */
  tab: JourneyTab;
}

export interface JourneyInput {
  teamSaved: boolean;
  /** null while unknown. */
  emailVerified: boolean | null;
  memberCount: number;
  /** A registration exists (status is not NOT_SUBMITTED). */
  submitted: boolean;
  status: string;
  isPaid: boolean;
}

export function buildTeamJourney(input: JourneyInput): JourneyStep[] {
  const { teamSaved, emailVerified, memberCount, submitted, status, isPaid } = input;
  const rank = submitted ? (STATUS_RANK[status] ?? 1) : -1;
  const steps: (Omit<JourneyStep, 'state'> & { done: boolean })[] = [
    {
      id: 'team',
      label: 'Team created',
      done: teamSaved,
      detail: teamSaved ? 'Your team record has been saved.' : 'Record your team details on the Overview page.',
      tab: 'overview'
    },
    {
      id: 'email',
      label: 'Email verified',
      done: emailVerified === true,
      detail:
        emailVerified === true
          ? 'The captain email address is verified.'
          : emailVerified === false
            ? 'Enter the six-digit code from the verification email.'
            : 'Checking the verification status.',
      tab: 'overview'
    },
    {
      id: 'members',
      label: 'Members',
      done: memberCount >= JOURNEY_LINE_UP,
      detail:
        memberCount >= JOURNEY_LINE_UP
          ? `${memberCount} people on the roster.`
          : `${memberCount} of ${JOURNEY_LINE_UP} players for the FIDA line-up.`,
      tab: 'members'
    },
    {
      id: 'submitted',
      label: 'Registration submitted',
      done: submitted,
      detail: submitted ? 'The registration has been submitted.' : 'Submit the registration from the Overview page.',
      tab: submitted ? 'status' : 'overview'
    },
    {
      id: 'payment',
      label: 'Payment',
      done: isPaid || rank >= 5,
      detail: isPaid || rank >= 5 ? 'The entry fee has been received.' : rank === 4 ? 'The entry fee is now due.' : 'Requested once the registration has been submitted.',
      tab: isPaid || rank >= 5 ? 'documents' : 'overview'
    },
    {
      id: 'inspection',
      label: 'Technical inspection',
      done: rank >= 9,
      detail: rank >= 9 ? 'Your drones have passed technical inspection.' : 'Drones are inspected against the FIDA specifications.',
      tab: 'status'
    },
    {
      id: 'approved',
      label: 'Approved / Match day',
      done: rank >= 10,
      detail: rank >= 12 ? 'Your team is competing.' : rank >= 10 ? 'Approved for the championship.' : 'Accreditation follows approval.',
      tab: 'status'
    }
  ];
  const firstOpen = steps.findIndex((s) => !s.done);
  return steps.map(({ done, ...s }, i) => ({ ...s, state: done ? 'done' : i === firstOpen ? 'current' : 'pending' }));
}
