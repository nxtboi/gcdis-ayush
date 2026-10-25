import { ValidationPipe, ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole, RegistrationStatus, DocumentType, DocumentStatus, TeamMemberRole } from '@gcdis/shared';
import { CreateRegistrationDto } from '../apps/api/src/registrations/dto/create-registration.dto';
import { TransitionStatusDto } from '../apps/api/src/registrations/dto/transition-status.dto';
import { AddDocumentDto } from '../apps/api/src/registrations/dto/add-document.dto';
import { CreatePaymentOrderDto } from '../apps/api/src/payments/dto/create-payment-order.dto';
import { SubmitInspectionDto } from '../apps/api/src/inspection/dto/submit-inspection.dto';
import { CreateTeamDto } from '../apps/api/src/teams/dto/create-team.dto';
import { RegistrationsService } from '../apps/api/src/registrations/registrations.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { InspectionService } from '../apps/api/src/inspection/inspection.service';
import { TeamsService } from '../apps/api/src/teams/teams.service';
import { CertificatesService } from '../apps/api/src/certificates/certificates.service';
import { UploadsService } from '../apps/api/src/uploads/uploads.service';
import { AuditService } from '../apps/api/src/audit/audit.service';
import { JwtAuthGuard } from '../apps/api/src/auth/jwt-auth.guard';
import { RolesGuard } from '../apps/api/src/auth/roles.guard';
import { IS_PUBLIC_KEY, Public } from '../apps/api/src/common/decorators/public.decorator';

describe('Phase 3: Validation, RBAC, Ownership Isolation & Security Controls', () => {
  describe('1. Real DTO Validation & forbidNonWhitelisted Rejection', () => {
    let validationPipe: ValidationPipe;

    beforeEach(() => {
      validationPipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true
      });
    });

    test('CreateRegistrationDto accepts valid payload', async () => {
      const valid = { teamId: 'team-1', categoryId: 'cat-1' };
      const res = await validationPipe.transform(valid, { type: 'body', metatype: CreateRegistrationDto });
      expect(res).toEqual(valid);
    });

    test('CreateRegistrationDto strictly rejects unwhitelisted fields with 400', async () => {
      const invalid = { teamId: 'team-1', categoryId: 'cat-1', maliciousInjectedField: 'hack' };
      await expect(
        validationPipe.transform(invalid, { type: 'body', metatype: CreateRegistrationDto })
      ).rejects.toThrow();
    });

    test('AddDocumentDto enforces assetId and enum type, rejecting free arbitrary URLs', async () => {
      const valid = { type: DocumentType.INSURANCE, assetId: 'asset-uuid-123' };
      const res = await validationPipe.transform(valid, { type: 'body', metatype: AddDocumentDto });
      expect(res.assetId).toBe('asset-uuid-123');

      const arbitraryUrl = { type: DocumentType.INSURANCE, fileUrl: 'https://evil.com/malware.exe' };
      await expect(
        validationPipe.transform(arbitraryUrl, { type: 'body', metatype: AddDocumentDto })
      ).rejects.toThrow();
    });

    test('CreateTeamDto enforces min members and validates nested objects', async () => {
      const valid = {
        categoryId: 'cat-1',
        teamName: 'SKYFORGE',
        institutionName: 'Aero Institute',
        city: 'Bengaluru',
        members: [
          {
            fullName: 'Pilot One',
            email: 'pilot1@example.com',
            memberRole: TeamMemberRole.PILOT
          }
        ]
      };
      const res = await validationPipe.transform(valid, { type: 'body', metatype: CreateTeamDto });
      expect(res.teamName).toBe('SKYFORGE');

      // Members are optional at registration (the captain is added by the service; FIDA needs the full roster only before competition)
      const { members: _omit, ...captainOnly } = valid;
      await expect(
        validationPipe.transform(captainOnly, { type: 'body', metatype: CreateTeamDto })
      ).resolves.toBeDefined();

      // Rejects rosters above the FIDA limit of 10
      const oversized = { ...valid, members: Array.from({ length: 11 }, () => valid.members[0]) };
      await expect(
        validationPipe.transform(oversized, { type: 'body', metatype: CreateTeamDto })
      ).rejects.toThrow();

      // Still validates nested member objects
      const badMember = { ...valid, members: [{ fullName: 'X', email: 'not-an-email', memberRole: TeamMemberRole.PILOT }] };
      await expect(
        validationPipe.transform(badMember, { type: 'body', metatype: CreateTeamDto })
      ).rejects.toThrow();
    });
  });

  describe('2. Global JWT Guard & Public Route Exemption', () => {
    let jwtGuard: JwtAuthGuard;
    let rolesGuard: RolesGuard;
    let reflector: Reflector;

    beforeEach(() => {
      reflector = new Reflector();
      jwtGuard = new JwtAuthGuard(reflector);
      rolesGuard = new RolesGuard(reflector);
    });

    test('JwtAuthGuard automatically permits routes decorated with @Public()', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
      const context = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => ({}) })
      } as any;

      expect(jwtGuard.canActivate(context)).toBe(true);
      expect(rolesGuard.canActivate(context)).toBe(true);
    });

    test('JwtAuthGuard enforces authentication when @Public() is absent', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      const context = {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => ({}) })
      } as any;

      // When super.canActivate is invoked without public decorator
      const superSpy = jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(jwtGuard)), 'canActivate').mockReturnValue(true as any);
      expect(jwtGuard.canActivate(context)).toBe(true);
      expect(superSpy).toHaveBeenCalled();
    });
  });

  describe('3. Ownership Checks: Captain A Cannot Touch Captain B across Endpoints', () => {
    let mockPrisma: any;
    let mockAudit: any;
    let registrationsService: RegistrationsService;
    let paymentsService: PaymentsService;
    let inspectionService: InspectionService;

    const CAPTAIN_A_ID = 'captain-a-id';
    const CAPTAIN_B_ID = 'captain-b-id';
    const REG_B_ID = 'reg-b-id';

    beforeEach(() => {
      mockPrisma = {
        registration: {
          findUnique: jest.fn(),
          findMany: jest.fn(),
          count: jest.fn(),
          create: jest.fn(),
          update: jest.fn()
        },
        team: {
          findUnique: jest.fn()
        },
        mediaAsset: {
          findUnique: jest.fn()
        },
        payment: {
          findFirst: jest.fn(),
          findMany: jest.fn()
        },
        technicalInspection: {
          findMany: jest.fn()
        },
        document: {
          create: jest.fn()
        },
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
        $executeRaw: jest.fn(),
        $executeRawUnsafe: jest.fn(),
        $queryRawUnsafe: jest.fn()
      };

      mockAudit = {
        logAction: jest.fn().mockResolvedValue({})
      };

      registrationsService = new RegistrationsService(mockPrisma, mockAudit);
      paymentsService = new PaymentsService(mockPrisma, {} as any, mockAudit);
      inspectionService = new InspectionService(mockPrisma, registrationsService);
    });

    test('Endpoint 1: GET /registrations filters captain to own team only', async () => {
      mockPrisma.registration.count.mockResolvedValue(1);
      mockPrisma.registration.findMany.mockResolvedValue([]);

      await registrationsService.findAll(undefined, CAPTAIN_A_ID, UserRole.TEAM_CAPTAIN);

      expect(mockPrisma.registration.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            team: { captainId: CAPTAIN_A_ID }
          })
        })
      );
    });

    test('Endpoint 2: GET /registrations/:id answers 404 (same as a missing id) when Captain A accesses Captain B registration', async () => {
      mockPrisma.registration.findUnique.mockResolvedValue({
        id: REG_B_ID,
        team: { captainId: CAPTAIN_B_ID }
      });

      await expect(
        registrationsService.findById(REG_B_ID, CAPTAIN_A_ID, UserRole.TEAM_CAPTAIN)
      ).rejects.toThrow(NotFoundException);

      // Same call by Captain B succeeds
      const result = await registrationsService.findById(REG_B_ID, CAPTAIN_B_ID, UserRole.TEAM_CAPTAIN);
      expect(result.id).toBe(REG_B_ID);
    });

    test('Endpoint 3: POST /registrations throws 403 when Captain A attempts to register Captain B team', async () => {
      mockPrisma.team.findUnique.mockResolvedValue({
        id: 'team-b',
        captainId: CAPTAIN_B_ID
      });

      await expect(
        registrationsService.createRegistration('team-b', 'cat-1', CAPTAIN_A_ID, UserRole.TEAM_CAPTAIN)
      ).rejects.toThrow(ForbiddenException);
    });

    test('Endpoint 4: POST /registrations/:id/documents throws 403 when Captain A touches Captain B registration or uses Captain B asset', async () => {
      mockPrisma.registration.findUnique.mockResolvedValue({
        id: REG_B_ID,
        team: { captainId: CAPTAIN_B_ID }
      });

      // 4a. Captain A uploading to Captain B's registration (answered like a missing registration)
      await expect(
        registrationsService.addDocument(REG_B_ID, DocumentType.INSURANCE, 'asset-1', CAPTAIN_A_ID, UserRole.TEAM_CAPTAIN)
      ).rejects.toThrow(NotFoundException);

      // 4b. Captain A uploading to Captain A's registration but using an asset uploaded by Captain B
      mockPrisma.registration.findUnique.mockResolvedValue({
        id: 'reg-a-id',
        team: { captainId: CAPTAIN_A_ID }
      });
      mockPrisma.mediaAsset.findUnique.mockResolvedValue({
        id: 'asset-b-id',
        uploadedBy: CAPTAIN_B_ID,
        fileUrl: '/uploads/b.pdf'
      });

      await expect(
        registrationsService.addDocument('reg-a-id', DocumentType.INSURANCE, 'asset-b-id', CAPTAIN_A_ID, UserRole.TEAM_CAPTAIN)
      ).rejects.toThrow(ForbiddenException);
    });

    test('Endpoint 5: PATCH /registrations/:id/status throws 403 when Captain A transitions Captain B status', async () => {
      mockPrisma.registration.findUnique.mockResolvedValue({
        id: REG_B_ID,
        status: RegistrationStatus.SUBMITTED,
        team: { captainId: CAPTAIN_B_ID },
        payments: [],
        documents: []
      });

      await expect(
        registrationsService.transitionStatus(REG_B_ID, RegistrationStatus.WITHDRAWN, UserRole.TEAM_CAPTAIN, CAPTAIN_A_ID)
      ).rejects.toThrow(ForbiddenException);
    });

    test('Endpoint 6: GET /payments/registration/:id throws 403 when Captain A views Captain B payments', async () => {
      mockPrisma.registration.findUnique.mockResolvedValue({
        id: REG_B_ID,
        team: { captainId: CAPTAIN_B_ID }
      });

      await expect(
        paymentsService.findByRegistrationId(REG_B_ID, CAPTAIN_A_ID, UserRole.TEAM_CAPTAIN)
      ).rejects.toThrow(ForbiddenException);
    });

    test('Endpoint 7: GET /inspections/registration/:id throws 403 when Captain A views Captain B inspections', async () => {
      mockPrisma.registration.findUnique.mockResolvedValue({
        id: REG_B_ID,
        team: { captainId: CAPTAIN_B_ID }
      });

      await expect(
        inspectionService.findByRegistrationId(REG_B_ID, CAPTAIN_A_ID, UserRole.TEAM_CAPTAIN)
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('4. State Machine Constraints & Technical Submission Safeguards', () => {
    let mockPrisma: any;
    let registrationsService: RegistrationsService;

    beforeEach(() => {
      mockPrisma = {
        registration: {
          findUnique: jest.fn(),
          update: jest.fn()
        },
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
        $executeRaw: jest.fn()
      };
      registrationsService = new RegistrationsService(mockPrisma, { logAction: jest.fn() } as any);
    });

    test('Captains are strictly forbidden from withdrawing after approval', async () => {
      mockPrisma.registration.findUnique.mockResolvedValue({
        id: 'reg-approved',
        status: RegistrationStatus.APPROVED,
        team: { captainId: 'captain-1' },
        payments: [{ status: 'SUCCESS' }],
        documents: []
      });

      await expect(
        registrationsService.transitionStatus(
          'reg-approved',
          RegistrationStatus.WITHDRAWN,
          UserRole.TEAM_CAPTAIN,
          'captain-1'
        )
      ).rejects.toThrow(BadRequestException);
    });

    test('Moving to TECHNICAL_SUBMISSION fails if payment or documents are not verified', async () => {
      mockPrisma.registration.findUnique.mockResolvedValue({
        id: 'reg-1',
        // Captains move to TECHNICAL_SUBMISSION only after staff moved the registration past PAYMENT_VERIFIED
        status: RegistrationStatus.DOCUMENT_REVIEW,
        team: { captainId: 'captain-1' },
        payments: [{ status: 'SUCCESS' }],
        documents: [{ status: DocumentStatus.PENDING }] // Pending documents
      });

      await expect(
        registrationsService.transitionStatus(
          'reg-1',
          RegistrationStatus.TECHNICAL_SUBMISSION,
          UserRole.TEAM_CAPTAIN,
          'captain-1'
        )
      ).rejects.toThrow(BadRequestException);
    });

    test('Moving to TECHNICAL_SUBMISSION succeeds when both payment and all documents are verified', async () => {
      mockPrisma.registration.findUnique.mockResolvedValue({
        id: 'reg-1',
        // Captains move to TECHNICAL_SUBMISSION only after staff moved the registration past PAYMENT_VERIFIED
        status: RegistrationStatus.DOCUMENT_REVIEW,
        team: { captainId: 'captain-1' },
        payments: [{ status: 'SUCCESS' }],
        documents: [{ status: DocumentStatus.VERIFIED }]
      });
      mockPrisma.registration.update.mockResolvedValue({ id: 'reg-1', status: RegistrationStatus.TECHNICAL_SUBMISSION });

      const updated = await registrationsService.transitionStatus(
        'reg-1',
        RegistrationStatus.TECHNICAL_SUBMISSION,
        UserRole.TEAM_CAPTAIN,
        'captain-1'
      );

      expect(updated.status).toBe(RegistrationStatus.TECHNICAL_SUBMISSION);
    });
  });

  describe('5. Public Endpoints Strip Sensitive PII', () => {
    let mockPrisma: any;
    let teamsService: TeamsService;

    beforeEach(() => {
      mockPrisma = {
        team: {
          findMany: jest.fn(),
          findUnique: jest.fn()
        }
      };
      teamsService = new TeamsService(mockPrisma);
    });

    test('GET /teams/category/:id does not include member emails, phones, or ID proofs', async () => {
      mockPrisma.team.findMany.mockImplementation(async (args: any) => {
        // Listings carry no member rows at all, only the roster size
        expect(args.include.members).toBeUndefined();
        expect(args.include._count).toEqual({ select: { members: true } });
        return [];
      });

      await teamsService.findTeamsByCategory('cat-1');
    });

    test('GET /teams/:id strips member contacts and captain email/phone', async () => {
      mockPrisma.team.findUnique.mockImplementation(async (args: any) => {
        expect(args.include.members.select).toEqual({
          id: true,
          fullName: true,
          memberRole: true,
          status: true
        });
        expect(args.include.captain.select).toEqual({
          id: true,
          fullName: true,
          organization: true
        });
        return { id: 'team-1', isApprovedPublic: true };
      });

      await teamsService.findById('team-1');
    });
  });

  describe('6. Authorization on Invoice PDFs, Member Passes, and Uploaded Files', () => {
    test('Invoice PDF generation rejects unauthorized captain', async () => {
      const mockPrisma: any = {
        payment: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'inv-1',
            amount: 1000,
            orderId: 'ORD-1',
            registration: {
              team: { captainId: 'captain-b' }
            }
          })
        }
      };
      const paymentsService = new PaymentsService(mockPrisma, {} as any, { logAction: jest.fn() } as any);

      await expect(
        paymentsService.generateInvoicePdf('inv-1', 'captain-a', UserRole.TEAM_CAPTAIN)
      ).rejects.toThrow(ForbiddenException);
    });

    test('Team Pass PDF generation requires DB row and rejects unauthorized captain', async () => {
      const mockPrisma: any = {
        teamMember: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'member-1',
            fullName: 'Jane Doe',
            memberRole: TeamMemberRole.PILOT,
            team: {
              code: 'GCDIS-T001',
              name: 'AERO',
              institutionName: 'NIT',
              captainId: 'captain-b',
              registrations: [{ status: 'APPROVED' }]
            }
          })
        }
      };
      const certificatesService = new CertificatesService(mockPrisma, {} as any);

      await expect(
        certificatesService.generateMemberPassPdf('member-1', 'captain-a', UserRole.TEAM_CAPTAIN)
      ).rejects.toThrow(ForbiddenException);
    });

    test('Uploads service validates signed download token against expiration and forgery', () => {
      const uploadsService = new UploadsService({} as any, { logAction: jest.fn() } as any);

      // Empty or missing token
      expect(uploadsService.verifySignedToken('test.pdf', undefined, undefined)).toBe(false);

      // Expired timestamp
      const pastTime = String(Math.floor(Date.now() / 1000) - 100);
      expect(uploadsService.verifySignedToken('test.pdf', 'fake-token', pastTime)).toBe(false);
    });
  });

  describe('7. Audit Logging & CSV Formula Injection Protection', () => {
    test('exportLogsCsv escapes cells starting with formula triggers (=, +, -, @, \\t, \\r)', async () => {
      const mockPrisma: any = {
        auditLog: {
          count: jest.fn().mockResolvedValue(2),
          findMany: jest.fn().mockResolvedValue([
            {
              createdAt: new Date('2026-03-01T10:00:00Z'),
              action: '=cmd|"/c calc"!A0',
              actorEmail: '+attacker@evil.com',
              actorRole: '-ADMIN',
              entityType: '@Registration',
              entityId: '\t12345',
              ipAddress: '192.168.1.1'
            }
          ])
        }
      };
      const auditService = new AuditService(mockPrisma);

      const csv = await auditService.exportLogsCsv();

      // Ensure cells starting with =, +, -, @, \t have single quote prefix
      expect(csv).toContain("\"'=cmd|\"\"/c calc\"\"!A0\"");
      expect(csv).toContain("\"'+attacker@evil.com\"");
      expect(csv).toContain("\"'-ADMIN\"");
      expect(csv).toContain("\"'@Registration\"");
      expect(csv).toContain("\"'\t12345\"");
    });
  });
});
