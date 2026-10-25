import { z } from 'zod';
import { UserRole, TeamMemberRole, DocumentType, PaymentGateway, MatchEventType } from '../enums';

export const LoginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters')
});

export const RegisterUserSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  fullName: z.string().min(2, 'Full name is required'),
  role: z.nativeEnum(UserRole).default(UserRole.TEAM_CAPTAIN),
  phone: z.string().optional(),
  organization: z.string().optional()
});

/** Championship roster limits: at most 7 people per team (including the captain), of whom at most 3 are coaches. */
export const FIDA_MAX_TEAM_SIZE = 7;
export const FIDA_MAX_COACHES = 3;

export const TeamMemberSchema = z.object({
  fullName: z.string().min(2, 'Member name is required').max(120),
  email: z.string().email('Invalid email address'),
  phone: z.string().min(10, 'Valid phone number is required').max(20).optional(),
  memberRole: z.nativeEnum(TeamMemberRole),
  idProofUrl: z
    .string()
    .regex(/^\/api\/uploads\/files\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/, 'ID proof must be a file uploaded through the portal')
    .optional(),
  tshirtSize: z.string().optional()
});

/** Members listed at team creation (the captain is added automatically by the API). */
const rosterLimits = (members: { memberRole: TeamMemberRole }[]) =>
  members.filter((m) => m.memberRole === TeamMemberRole.COACH).length <= FIDA_MAX_COACHES;

export const TeamRegistrationSchema = z.object({
  categoryId: z.string().uuid('Invalid category ID'),
  teamName: z.string().min(3, 'Team name must be at least 3 characters').max(80),
  institutionName: z.string().min(2, 'Institution name is required').max(160),
  city: z.string().min(2, 'City is required').max(80),
  country: z.string().min(2, 'Country is required').max(80).optional(),
  // FIDA requires the full roster only before competition; a team may be created with the captain alone.
  members: z
    .array(TeamMemberSchema)
    .max(FIDA_MAX_TEAM_SIZE - 1, `A team has at most ${FIDA_MAX_TEAM_SIZE} members including the captain`)
    .refine(rosterLimits, `A team has at most ${FIDA_MAX_COACHES} coaches`)
    .optional()
});

export const DocumentUploadSchema = z.object({
  registrationId: z.string().uuid(),
  type: z.nativeEnum(DocumentType),
  fileUrl: z.string().url('Invalid file URL')
});

export const CreatePaymentOrderSchema = z.object({
  registrationId: z.string().uuid(),
  gateway: z.nativeEnum(PaymentGateway).default(PaymentGateway.SIMULATED)
});

export const TechnicalInspectionSubmissionSchema = z.object({
  registrationId: z.string().uuid(),
  checks: z.record(z.object({
    passed: z.boolean(),
    value: z.any().optional(),
    note: z.string().optional()
  })),
  notes: z.string().optional(),
  photos: z.array(z.string().url()).optional()
});

export const MatchEventLogSchema = z.object({
  fixtureId: z.string().uuid(),
  teamId: z.string().uuid(),
  eventType: z.nativeEnum(MatchEventType),
  scoreDelta: z.number().default(1),
  notes: z.string().optional()
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type RegisterUserInput = z.infer<typeof RegisterUserSchema>;
export type TeamRegistrationInput = z.infer<typeof TeamRegistrationSchema>;
export type DocumentUploadInput = z.infer<typeof DocumentUploadSchema>;
export type CreatePaymentOrderInput = z.infer<typeof CreatePaymentOrderSchema>;
export type TechnicalInspectionInput = z.infer<typeof TechnicalInspectionSubmissionSchema>;
export type MatchEventLogInput = z.infer<typeof MatchEventLogSchema>;
