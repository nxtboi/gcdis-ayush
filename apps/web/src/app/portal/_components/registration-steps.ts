/**
 * Registration timeline shown on the Registration Status tab, derived from the live registration status,
 * payment and documents. Pure logic (no React or path aliases) so it can be unit-tested.
 */

/** Order of the registration workflow (RegistrationStatus); later stages imply the earlier ones are complete. */
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

export type StepState = 'done' | 'current' | 'pending';

export interface RegistrationStep {
  title: string;
  desc: string;
  state: StepState;
}

/** Derives the registration timeline from the live registration status, payment and documents. */
export function buildRegistrationSteps(input: {
  submitted: boolean;
  status: string;
  isPaid: boolean;
  documents: { status: string }[];
  category?: string;
}): RegistrationStep[] {
  const { submitted, status, isPaid, documents, category } = input;
  const rank = submitted ? (STATUS_RANK[status] ?? 1) : -1;
  const verifiedDocs = documents.filter((d) => d.status === 'VERIFIED' || d.status === 'APPROVED').length;
  const rejectedDocs = documents.filter((d) => d.status === 'REJECTED').length;
  const docsVerified = documents.length > 0 && verifiedDocs === documents.length;

  // Registrations start at PAYMENT_PENDING and the Secretariat's administrative review follows payment
  // (PAYMENT_VERIFIED -> ADMINISTRATIVE_REVIEW -> DOCUMENT_REVIEW), so the review is complete only once the
  // entry has been paid and has moved on to document review or a later stage.
  const paymentDone = isPaid || rank >= 5;
  const reviewDone = paymentDone && rank >= 6;
  const documentsDone = rank >= 7 || docsVerified;
  const inspectionDone = rank >= 10;
  const accreditationDone = rank >= 11;

  const steps: {
    title: string;
    done: boolean;
    doneDesc: string;
    pendingDesc: string;
  }[] = [
    {
      title: 'Team Registration Submitted',
      done: submitted,
      doneDesc: `Registration submitted for ${category || 'your competition category'}.`,
      pendingDesc: 'Complete the team registration form on the Overview page.'
    },
    {
      title: 'Entry Fee Payment',
      done: paymentDone,
      doneDesc: 'The entry fee has been received and verified.',
      pendingDesc:
        status === 'PAYMENT_PENDING'
          ? 'Payment is now due. Please pay the entry fee from the Overview page.'
          : 'Payment is requested once the registration has been submitted.'
    },
    {
      title: 'Administrative Review',
      done: reviewDone,
      doneDesc: 'Your registration has been reviewed by the GCDIS Secretariat.',
      pendingDesc:
        status === 'ADMINISTRATIVE_REVIEW' && paymentDone
          ? 'The GCDIS Secretariat is reviewing your registration.'
          : 'The GCDIS Secretariat reviews your registration after the entry fee has been paid.'
    },
    {
      title: 'Document Verification',
      done: documentsDone,
      doneDesc: 'All submitted documents have been verified.',
      pendingDesc:
        documents.length === 0
          ? 'Upload your institutional approval letter (NOC) and other required documents.'
          : rejectedDocs > 0
            ? `${rejectedDocs} document${rejectedDocs === 1 ? ' requires' : 's require'} resubmission. Please review the reviewer's notes.`
            : `${verifiedDocs} of ${documents.length} document${documents.length === 1 ? '' : 's'} verified; the remainder are under review.`
    },
    {
      title: 'Technical Inspection and Eligibility',
      done: inspectionDone,
      doneDesc: 'Your drones have passed technical inspection against the FIDA specifications.',
      pendingDesc: 'Drones will be inspected against the FIDA specifications for your class.'
    },
    {
      title: 'Accreditation and Match Allocation',
      done: accreditationDone,
      doneDesc: 'Your team is accredited and allocated to the match schedule.',
      pendingDesc: 'Accreditation passes and match slots are issued after approval.'
    }
  ];

  const firstOpen = steps.findIndex((s) => !s.done);
  return steps.map((s, i) => ({
    title: s.title,
    desc: s.done ? s.doneDesc : s.pendingDesc,
    state: s.done ? 'done' : i === firstOpen ? 'current' : 'pending'
  }));
}
