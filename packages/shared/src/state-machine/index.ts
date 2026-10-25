import { RegistrationStatus, MatchStatus, UserRole } from '../enums';

export const ALLOWED_REGISTRATION_TRANSITIONS: Record<RegistrationStatus, RegistrationStatus[]> = {
  [RegistrationStatus.DRAFT]: [
    RegistrationStatus.SUBMITTED,
    RegistrationStatus.WITHDRAWN
  ],
  [RegistrationStatus.SUBMITTED]: [
    RegistrationStatus.FACULTY_ENDORSED,
    RegistrationStatus.ADMINISTRATIVE_REVIEW,
    RegistrationStatus.REQUIRES_ACTION,
    RegistrationStatus.REJECTED,
    RegistrationStatus.WITHDRAWN
  ],
  [RegistrationStatus.FACULTY_ENDORSED]: [
    RegistrationStatus.ADMINISTRATIVE_REVIEW,
    RegistrationStatus.REQUIRES_ACTION,
    RegistrationStatus.REJECTED,
    RegistrationStatus.WITHDRAWN
  ],
  // DOCUMENT_REVIEW is only for entries that have already been paid (a post-payment review); the
  // registrations service refuses it otherwise, so an unpaid entry cannot skip the payment step.
  [RegistrationStatus.ADMINISTRATIVE_REVIEW]: [
    RegistrationStatus.PAYMENT_PENDING,
    RegistrationStatus.DOCUMENT_REVIEW,
    RegistrationStatus.REQUIRES_ACTION,
    RegistrationStatus.REJECTED,
    RegistrationStatus.WITHDRAWN
  ],
  [RegistrationStatus.PAYMENT_PENDING]: [
    RegistrationStatus.PAYMENT_VERIFIED,
    RegistrationStatus.REQUIRES_ACTION,
    RegistrationStatus.CANCELLED,
    RegistrationStatus.WITHDRAWN
  ],
  // Registrations now start at PAYMENT_PENDING, so the Secretariat's administrative review (and a
  // possible rejection) happens after payment.
  [RegistrationStatus.PAYMENT_VERIFIED]: [
    RegistrationStatus.ADMINISTRATIVE_REVIEW,
    RegistrationStatus.DOCUMENT_REVIEW,
    RegistrationStatus.TECHNICAL_SUBMISSION,
    RegistrationStatus.REQUIRES_ACTION,
    RegistrationStatus.REJECTED,
    RegistrationStatus.WITHDRAWN
  ],
  [RegistrationStatus.DOCUMENT_REVIEW]: [
    RegistrationStatus.TECHNICAL_SUBMISSION,
    RegistrationStatus.REQUIRES_ACTION,
    RegistrationStatus.REJECTED,
    RegistrationStatus.WITHDRAWN
  ],
  [RegistrationStatus.TECHNICAL_SUBMISSION]: [
    RegistrationStatus.TECHNICAL_INSPECTION,
    RegistrationStatus.REQUIRES_ACTION,
    RegistrationStatus.WITHDRAWN
  ],
  [RegistrationStatus.TECHNICAL_INSPECTION]: [
    RegistrationStatus.ELIGIBILITY_REVIEW,
    RegistrationStatus.REQUIRES_ACTION,
    RegistrationStatus.REJECTED,
    RegistrationStatus.WITHDRAWN
  ],
  [RegistrationStatus.ELIGIBILITY_REVIEW]: [
    RegistrationStatus.APPROVED,
    RegistrationStatus.REQUIRES_ACTION,
    RegistrationStatus.REJECTED,
    RegistrationStatus.WITHDRAWN
  ],
  [RegistrationStatus.APPROVED]: [
    RegistrationStatus.ACCREDITED
    // Captain cannot withdraw once approved!
  ],
  [RegistrationStatus.ACCREDITED]: [
    RegistrationStatus.COMPETING
    // Captain cannot withdraw once accredited!
  ],
  [RegistrationStatus.COMPETING]: [
    RegistrationStatus.ARENA_CLEARED,
    RegistrationStatus.COMPLETED
  ],
  [RegistrationStatus.ARENA_CLEARED]: [
    RegistrationStatus.COMPLETED
  ],
  [RegistrationStatus.COMPLETED]: [],
  [RegistrationStatus.REQUIRES_ACTION]: [
    RegistrationStatus.SUBMITTED,
    RegistrationStatus.DOCUMENT_REVIEW,
    RegistrationStatus.TECHNICAL_SUBMISSION,
    RegistrationStatus.WITHDRAWN
  ],
  [RegistrationStatus.REJECTED]: [],
  [RegistrationStatus.WITHDRAWN]: [],
  [RegistrationStatus.CANCELLED]: []
};

export const POST_APPROVAL_STATUSES: RegistrationStatus[] = [
  RegistrationStatus.APPROVED,
  RegistrationStatus.ACCREDITED,
  RegistrationStatus.COMPETING,
  RegistrationStatus.ARENA_CLEARED,
  RegistrationStatus.COMPLETED
];

export function canTransitionRegistration(
  currentStatus: RegistrationStatus,
  targetStatus: RegistrationStatus
): boolean {
  const allowed = ALLOWED_REGISTRATION_TRANSITIONS[currentStatus];
  return allowed ? allowed.includes(targetStatus) : false;
}

export const ALLOWED_MATCH_TRANSITIONS: Record<MatchStatus, MatchStatus[]> = {
  [MatchStatus.SCHEDULED]: [MatchStatus.CHECK_IN, MatchStatus.READY],
  [MatchStatus.CHECK_IN]: [MatchStatus.READY, MatchStatus.SCHEDULED],
  [MatchStatus.READY]: [MatchStatus.LIVE, MatchStatus.SCHEDULED],
  [MatchStatus.LIVE]: [MatchStatus.PAUSED, MatchStatus.COMPLETED],
  [MatchStatus.PAUSED]: [MatchStatus.LIVE, MatchStatus.COMPLETED],
  [MatchStatus.COMPLETED]: [MatchStatus.VERIFIED, MatchStatus.LIVE],
  [MatchStatus.VERIFIED]: []
};

export function canTransitionMatch(
  currentStatus: MatchStatus,
  targetStatus: MatchStatus
): boolean {
  const allowed = ALLOWED_MATCH_TRANSITIONS[currentStatus];
  return allowed ? allowed.includes(targetStatus) : false;
}

/**
 * Statuses from which a captain may move their registration to TECHNICAL_SUBMISSION: only after staff
 * have moved it past PAYMENT_VERIFIED. The registrations service additionally requires a SUCCESS
 * payment and every uploaded document verified.
 */
export const CAPTAIN_TECHNICAL_SUBMISSION_FROM: RegistrationStatus[] = [
  RegistrationStatus.DOCUMENT_REVIEW,
  RegistrationStatus.REQUIRES_ACTION
];

export function isRoleAuthorizedForTransition(
  userRole: UserRole,
  targetStatus: RegistrationStatus,
  currentStatus?: RegistrationStatus
): boolean {
  if (userRole === UserRole.SUPER_ADMIN || userRole === UserRole.EVENT_ADMIN) {
    return true;
  }

  if (userRole === UserRole.INSPECTOR) {
    return [
      RegistrationStatus.ELIGIBILITY_REVIEW,
      RegistrationStatus.REQUIRES_ACTION,
      RegistrationStatus.REJECTED
    ].includes(targetStatus);
  }

  if (userRole === UserRole.TEAM_CAPTAIN) {
    // Captains can only SUBMIT, WITHDRAW (strictly before approval), and TECHNICAL_SUBMISSION
    if (targetStatus === RegistrationStatus.SUBMITTED) {
      return true;
    }

    if (targetStatus === RegistrationStatus.TECHNICAL_SUBMISSION) {
      // Only once staff have taken the registration past PAYMENT_VERIFIED (document review, or a
      // staff request for action); never straight from PAYMENT_VERIFIED or with an unknown status.
      return !!currentStatus && CAPTAIN_TECHNICAL_SUBMISSION_FROM.includes(currentStatus);
    }

    if (targetStatus === RegistrationStatus.WITHDRAWN) {
      // Must not withdraw once approved
      if (currentStatus && POST_APPROVAL_STATUSES.includes(currentStatus)) {
        return false;
      }
      return true;
    }

    return false;
  }

  return false;
}
