import {
  UserRole,
  EventStatus,
  RegistrationStatus,
  DocumentType,
  DocumentStatus,
  PaymentStatus,
  PaymentGateway,
  InspectionStatus,
  MatchStage,
  MatchStatus,
  MatchEventType,
  SponsorTier,
  TeamMemberRole
} from '../enums';

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  phone?: string;
  organization?: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Event {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  bannerUrl: string;
  startDate: string;
  endDate: string;
  venueName: string;
  venueAddress: string;
  status: EventStatus;
  categories?: Category[];
  sponsors?: Sponsor[];
}

export interface TechnicalRequirementField {
  key: string;
  label: string;
  type: 'number' | 'text' | 'boolean' | 'select';
  unit?: string;
  minValue?: number;
  maxValue?: number;
  options?: string[];
  required: boolean;
}

export interface Category {
  id: string;
  eventId: string;
  slug: string;
  name: string; // e.g. D20, D40
  minTeamSize: number;
  maxTeamSize: number;
  entryFee: number;
  currency: string;
  technicalSpecsSchema: TechnicalRequirementField[];
  rulesPdfUrl: string;
  isActive: boolean;
}

export interface TeamMember {
  id: string;
  teamId: string;
  userId?: string;
  fullName: string;
  email: string;
  phone: string;
  memberRole: TeamMemberRole;
  idProofUrl?: string;
  tshirtSize?: string;
}

export interface Team {
  id: string;
  categoryId: string;
  name: string;
  code: string;
  logoUrl?: string;
  captainId: string;
  institutionName: string;
  city: string;
  country: string;
  isApprovedPublic: boolean;
  members?: TeamMember[];
}

export interface DocumentRecord {
  id: string;
  registrationId: string;
  type: DocumentType;
  fileUrl: string;
  status: DocumentStatus;
  feedback?: string;
  uploadedAt: string;
}

export interface PaymentRecord {
  id: string;
  registrationId: string;
  orderId: string;
  paymentId?: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  gateway: PaymentGateway;
  gatewaySignature?: string;
  paidAt?: string;
}

export interface TechnicalInspectionRecord {
  id: string;
  registrationId: string;
  inspectorId: string;
  inspectorName?: string;
  checks: Record<string, { passed: boolean; value?: any; note?: string }>;
  status: InspectionStatus;
  notes?: string;
  photos?: string[];
  inspectedAt: string;
}

export interface Registration {
  id: string;
  registrationCode: string;
  teamId: string;
  categoryId: string;
  status: RegistrationStatus;
  submittedAt: string;
  approvedAt?: string;
  team?: Team;
  category?: Category;
  documents?: DocumentRecord[];
  payments?: PaymentRecord[];
  inspections?: TechnicalInspectionRecord[];
}

export interface Arena {
  id: string;
  eventId: string;
  name: string;
  code: string;
  description?: string;
}

export interface Fixture {
  id: string;
  categoryId: string;
  arenaId: string;
  matchNumber: number;
  stage: MatchStage;
  team1Id: string;
  team2Id: string;
  team1Name?: string;
  team2Name?: string;
  team1Score: number;
  team2Score: number;
  winnerId?: string;
  status: MatchStatus;
  scheduledStart: string;
  actualStart?: string;
  actualEnd?: string;
  refereeId?: string;
  refereeName?: string;
  arenaName?: string;
}

export interface MatchEvent {
  id: string;
  fixtureId: string;
  teamId: string;
  timestamp: string;
  eventType: MatchEventType;
  scoreDelta: number;
  notes?: string;
  loggedBy: string;
}

export interface Ranking {
  id: string;
  categoryId: string;
  teamId: string;
  teamName: string;
  institutionName: string;
  played: number;
  won: number;
  lost: number;
  drawn: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  points: number;
  rank: number;
}

export interface Sponsor {
  id: string;
  eventId: string;
  name: string;
  tier: SponsorTier;
  logoUrl: string;
  websiteUrl?: string;
  displayOrder: number;
}

export interface Certificate {
  id: string;
  code: string;
  registrationId: string;
  recipientName: string;
  teamName: string;
  achievementTitle: string;
  issuedDate: string;
  pdfUrl: string;
  qrVerificationUrl: string;
}

export interface CMSContent {
  id: string;
  slug: string;
  title: string;
  content: string;
  section: string;
  isPublished: boolean;
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  actorId: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  previousState?: Record<string, any>;
  newState?: Record<string, any>;
  ipAddress?: string;
  createdAt: string;
}
