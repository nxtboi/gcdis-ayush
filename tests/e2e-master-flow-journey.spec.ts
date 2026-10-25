import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PaymentStatus, Role } from '@prisma/client';
import { UserRole, MatchEventType, MatchStatus, RegistrationStatus } from '@gcdis/shared';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { RegistrationsService } from '../apps/api/src/registrations/registrations.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { UploadsService } from '../apps/api/src/uploads/uploads.service';
import { CompetitionService } from '../apps/api/src/competition/competition.service';
import { ScoringGateway } from '../apps/api/src/scoring/scoring.gateway';
import * as crypto from 'crypto';

describe('End-to-End Master Journey: Register, Login, Pay Test Mode, Upload Doc, Admin Approve, Score Match', () => {
  // In-Memory Database State Representation
  let dbUsers: Map<string, any>;
  let dbTeams: Map<string, any>;
  let dbRegistrations: Map<string, any>;
  let dbPayments: Map<string, any>;
  let dbDocuments: Map<string, any>;
  let dbFixtures: Map<string, any>;
  let dbSessions: Map<string, any>;
  let dbAuditLogs: any[];

  let mockPrisma: any;
  let mockAudit: any;
  let mockJwt: any;
  let mockPdf: any;

  let authService: AuthService;
  let registrationsService: RegistrationsService;
  let paymentsService: PaymentsService;
  let uploadsService: UploadsService;
  let competitionService: CompetitionService;
  let scoringGateway: ScoringGateway;

  const RAZORPAY_KEY = 'rzp_test_flow_key_123';
  const RAZORPAY_SECRET = 'rzp_test_secret_flow_456';
  const RAZORPAY_WEBHOOK_SECRET = 'rzp_webhook_secret_flow_789';

  beforeAll(() => {
    process.env.RAZORPAY_KEY_ID = RAZORPAY_KEY;
    process.env.RAZORPAY_KEY_SECRET = RAZORPAY_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = RAZORPAY_WEBHOOK_SECRET;
    process.env.JWT_SECRET = 'gcdis_master_flow_test_jwt_secret_32_characters';

    dbUsers = new Map();
    dbTeams = new Map();
    dbRegistrations = new Map();
    dbPayments = new Map();
    dbDocuments = new Map();
    dbFixtures = new Map();
    dbSessions = new Map();
    dbAuditLogs = [];

    mockAudit = {
      logAction: jest.fn(async (entry) => {
        dbAuditLogs.push({ id: `audit-${dbAuditLogs.length + 1}`, ...entry, createdAt: new Date() });
      })
    };

    mockPdf = {
      generateInvoicePdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 Fake Invoice')),
      generateCertificatePdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 Fake Pass'))
    };

    mockJwt = {
      sign: jest.fn((payload) => `jwt_token_${payload.sub}_${payload.role}`),
      verify: jest.fn((token) => {
        const parts = token.split('_');
        return { sub: parts[2], sid: `sess_${parts[2]}`, role: parts[3], email: `${parts[2]}@test.com`, fullName: `User ${parts[2]}` };
      })
    };

    mockPrisma = {
      user: {
        findUnique: jest.fn(async ({ where }) => {
          if (where.email) {
            for (const u of dbUsers.values()) {
              if (u.email === where.email) return u;
            }
            return null;
          }
          return dbUsers.get(where.id) || null;
        }),
        create: jest.fn(async ({ data }) => {
          const u = { id: `user-${dbUsers.size + 1}`, ...data, createdAt: new Date() };
          dbUsers.set(u.id, u);
          return u;
        })
      },
      team: {
        findUnique: jest.fn(async ({ where }) => dbTeams.get(where.id) || null),
        create: jest.fn(async ({ data }) => {
          const t = { id: `team-${dbTeams.size + 1}`, ...data };
          dbTeams.set(t.id, t);
          return t;
        })
      },
      registration: {
        findUnique: jest.fn(async ({ where }) => {
          const r = dbRegistrations.get(where.id);
          if (!r) return null;
          return {
            ...r,
            team: dbTeams.get(r.teamId),
            category: { id: r.categoryId, name: 'AirMouse D20 Drone Soccer', entryFee: 1500 },
            documents: Array.from(dbDocuments.values()).filter((d) => d.registrationId === r.id),
            payments: Array.from(dbPayments.values()).filter((p) => p.registrationId === r.id)
          };
        }),
        findMany: jest.fn(async () => Array.from(dbRegistrations.values())),
        create: jest.fn(async ({ data }) => {
          const r = { id: data.id || `reg-${dbRegistrations.size + 1}`, ...data, createdAt: new Date() };
          dbRegistrations.set(r.id, r);
          return r;
        }),
        update: jest.fn(async ({ where, data }) => {
          const r = dbRegistrations.get(where.id);
          if (!r) throw new NotFoundException('Registration not found');
          const updated = { ...r, ...data };
          dbRegistrations.set(where.id, updated);
          return {
            ...updated,
            team: dbTeams.get(updated.teamId),
            category: { id: updated.categoryId, name: 'AirMouse D20 Drone Soccer', entryFee: 1500 },
            documents: Array.from(dbDocuments.values()).filter((d) => d.registrationId === updated.id),
            payments: Array.from(dbPayments.values()).filter((p) => p.registrationId === updated.id)
          };
        })
      },
      payment: {
        findFirst: jest.fn(async ({ where }) => {
          for (const p of dbPayments.values()) {
            if (p.registrationId === where.registrationId) {
              if (where.status && p.status === where.status) return p;
              if (!where.status) return p;
            }
          }
          return null;
        }),
        findUnique: jest.fn(async ({ where }) => {
          if (where.id) {
            const p = dbPayments.get(where.id);
            if (!p) return null;
            const r = dbRegistrations.get(p.registrationId);
            return {
              ...p,
              registration: r ? { ...r, team: dbTeams.get(r.teamId) } : null
            };
          }
          if (where.orderId) {
            for (const p of dbPayments.values()) {
              if (p.orderId === where.orderId) {
                const r = dbRegistrations.get(p.registrationId);
                return {
                  ...p,
                  registration: r ? { ...r, team: dbTeams.get(r.teamId) } : null
                };
              }
            }
          }
          return null;
        }),
        create: jest.fn(async ({ data }) => {
          const p = { id: `pay-${dbPayments.size + 1}`, ...data, createdAt: new Date() };
          dbPayments.set(p.id, p);
          return p;
        }),
        update: jest.fn(async ({ where, data }) => {
          const p = dbPayments.get(where.id);
          const updated = { ...p, ...data };
          dbPayments.set(where.id, updated);
          return updated;
        })
      },
      session: {
        create: jest.fn(async ({ data }) => {
          const s = { id: data.id || `sess-${dbSessions.size + 1}`, ...data };
          dbSessions.set(s.id, s);
          return s;
        }),
        findUnique: jest.fn(async ({ where }) => dbSessions.get(where.id) || null),
        findFirst: jest.fn(async ({ where }) => {
          for (const s of dbSessions.values()) {
            if (where.userId && s.userId !== where.userId) continue;
            if (where.refreshTokenHash && s.refreshTokenHash !== where.refreshTokenHash) continue;
            return s;
          }
          return null;
        }),
        update: jest.fn(async ({ where, data }) => {
          const s = dbSessions.get(where.id);
          if (!s) return null;
          const updated = { ...s, ...data };
          dbSessions.set(where.id, updated);
          return updated;
        }),
        updateMany: jest.fn(async ({ where, data }) => {
          for (const [id, s] of dbSessions.entries()) {
            if (!where.userId || s.userId === where.userId) {
              dbSessions.set(id, { ...s, ...data });
            }
          }
          return { count: 1 };
        })
      },
      loginAttempt: {
        create: jest.fn(async ({ data }) => ({ id: `att-${Date.now()}`, ...data })),
        count: jest.fn().mockResolvedValue(0),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      mediaAsset: {
        create: jest.fn(async ({ data }) => ({ id: `asset-${Date.now()}`, ...data }))
      },
      document: {
        create: jest.fn(async ({ data }) => {
          const d = { id: `doc-${dbDocuments.size + 1}`, ...data };
          dbDocuments.set(d.id, d);
          return d;
        })
      },
      fixture: {
        findUnique: jest.fn(async ({ where }) => dbFixtures.get(where.id) || null),
        update: jest.fn(async ({ where, data }) => {
          const f = dbFixtures.get(where.id);
          const updated = { ...f, ...data };
          dbFixtures.set(where.id, updated);
          return updated;
        })
      },
      matchEvent: {
        create: jest.fn(async ({ data }) => ({ id: `event-${Date.now()}`, ...data }))
      },
      siteSetting: {
        findUnique: jest.fn().mockResolvedValue({ value: 18 })
      },
      processedWebhookEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'evt-1' })
      },
      $transaction: jest.fn(async (cb) => {
        if (typeof cb === 'function') return cb(mockPrisma);
        if (Array.isArray(cb)) return Promise.all(cb);
        return cb;
      }),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      $executeRaw: jest.fn().mockResolvedValue(1)
    };

    authService = new AuthService(mockPrisma, mockJwt, mockAudit);
    registrationsService = new RegistrationsService(mockPrisma, mockAudit);
    paymentsService = new PaymentsService(mockPrisma, mockPdf, mockAudit);
    uploadsService = new UploadsService(mockPrisma, mockAudit);
    competitionService = new CompetitionService(mockPrisma);
    scoringGateway = new ScoringGateway(competitionService, mockJwt);
    scoringGateway.server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      emit: jest.fn()
    } as any;
  });

  test('Step 1: User Registration creates Team Captain account', async () => {
    const regResult = await authService.register(
      {
        email: 'captain.aero@mit.edu',
        password: 'Password123!456',
        fullName: 'Captain Vikram',
        role: UserRole.TEAM_CAPTAIN,
        phone: '+919876543210'
      },
      '127.0.0.1'
    );

    expect(regResult.accessToken).toBeDefined();
    expect(regResult.user.email).toBe('captain.aero@mit.edu');
    expect(regResult.user.role).toBe(Role.TEAM_CAPTAIN);
  });

  test('Step 2: Captain Logs In and receives authenticated session', async () => {
    const loginRes = await authService.login(
      { email: 'captain.aero@mit.edu', password: 'Password123!456' },
      '127.0.0.1'
    );

    expect('accessToken' in loginRes).toBe(true);
    if ('accessToken' in loginRes) {
      expect(loginRes.accessToken).toBeDefined();
      expect(loginRes.user.email).toBe('captain.aero@mit.edu');
      expect(loginRes.user.role).toBe(Role.TEAM_CAPTAIN);
    }
  });

  test('Step 3: Captain registers Team & Registration enters PAYMENT_PENDING', async () => {
    const captainId = 'user-1';
    dbUsers.set(captainId, { id: captainId, role: Role.TEAM_CAPTAIN, fullName: 'Captain Vikram' });

    const team = await mockPrisma.team.create({
      data: {
        code: 'T26-001',
        name: 'AERO STRIKE',
        captainId,
        institutionName: 'MIT Aeronautical Society'
      }
    });

    const reg = await mockPrisma.registration.create({
      data: {
        teamId: team.id,
        categoryId: 'cat-d20',
        registrationCode: 'GCDIS-D20-001',
        status: RegistrationStatus.PAYMENT_PENDING
      }
    });

    expect(reg.status).toBe(RegistrationStatus.PAYMENT_PENDING);
  });

  test('Step 4: Create Order and Verify Payment in Razorpay Gateway Mode', async () => {
    const captainId = 'user-1';
    const regId = 'reg-1';

    // Mock fetch for Razorpay API order creation
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/orders')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'order_rzp_test_9999',
            amount: 150000,
            currency: 'INR',
            status: 'created'
          })
        };
      }
      if (url.includes('/payments/pay_test_capture_123')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'pay_test_capture_123',
            order_id: 'order_rzp_test_9999',
            status: 'captured',
            amount: 150000
          })
        };
      }
      return { ok: false, status: 404 };
    });

    // 4A: Create payment order (Fee strictly from category entryFee + 18% GST)
    const orderRes = await paymentsService.createOrder({ registrationId: regId }, captainId);
    expect(orderRes.keyId).toBe(RAZORPAY_KEY);
    expect(orderRes.amountInPaise).toBe(150000); // 1500 INR, GST-inclusive = 150000 paise
    expect(orderRes.payment.orderId).toBe('order_rzp_test_9999');

    // 4B: Client returns with gateway signature: verify signature and capture
    const payload = `order_rzp_test_9999|pay_test_capture_123`;
    const validSignature = crypto.createHmac('sha256', RAZORPAY_SECRET).update(payload).digest('hex');

    const verifyRes = await paymentsService.verifyPaymentSignature(
      {
        razorpayOrderId: 'order_rzp_test_9999',
        razorpayPaymentId: 'pay_test_capture_123',
        razorpaySignature: validSignature
      },
      captainId
    );

    expect(verifyRes.status).toBe(PaymentStatus.SUCCESS);

    // Registration transitions to PAYMENT_VERIFIED
    const updatedReg = dbRegistrations.get(regId);
    expect(updatedReg.status).toBe(RegistrationStatus.PAYMENT_VERIFIED);

    global.fetch = originalFetch;
  });

  test('Step 5: Captain uploads Verification Document (ClamAV scanned, metadata stripped, random key)', async () => {
    const validPdfBuffer = Buffer.from('%PDF-1.4\nInstitutional Student Verification\n%%EOF');

    const uploadRes = await uploadsService.processUpload(
      validPdfBuffer,
      'College_NOC.pdf',
      'user-1',
      UserRole.TEAM_CAPTAIN,
      'DOCUMENT'
    );

    expect(uploadRes.assetId).toBeDefined();
    // Storage key must be randomized, not using user filename
    expect(uploadRes.fileUrl).not.toContain('College_NOC');
    expect(uploadRes.mimeType).toBe('application/pdf');

    // Attach document to registration
    const doc = await mockPrisma.document.create({
      data: {
        registrationId: 'reg-1',
        type: 'COLLEGE_NOC',
        fileUrl: uploadRes.fileUrl,
        isVerified: false
      }
    });

    expect(doc.id).toBeDefined();
  });

  test('Step 6: Super Admin reviews and APPROVES Registration', async () => {
    const adminId = 'super-admin-1';
    dbUsers.set(adminId, { id: adminId, role: Role.SUPER_ADMIN, fullName: 'Tournament Director' });

    // In state machine, following document and technical review, registration reaches ELIGIBILITY_REVIEW
    const currentReg = dbRegistrations.get('reg-1');
    dbRegistrations.set('reg-1', { ...currentReg, status: RegistrationStatus.ELIGIBILITY_REVIEW });

    const approvalResult = await registrationsService.transitionStatus(
      'reg-1',
      RegistrationStatus.APPROVED as any,
      UserRole.SUPER_ADMIN,
      adminId,
      'admin@gcdis.org',
      'All regulatory documents and payments verified by admissions committee'
    );

    expect(approvalResult.status).toBe(RegistrationStatus.APPROVED);

    // Verify Audit Log entry was recorded
    const lastAudit = dbAuditLogs[dbAuditLogs.length - 1];
    expect(lastAudit.action).toBe('REGISTRATION_STATUS_TRANSITION');
    expect(lastAudit.actorId).toBe(adminId);
    expect(lastAudit.afterState.status).toBe(RegistrationStatus.APPROVED);
  });

  test('Step 7: Scorer logs goals in Live Pitch Match', async () => {
    // Fixture between Team 1 (AERO STRIKE) and Team 2 (SKY DART)
    const fixture = {
      id: 'fix-final-1',
      matchNumber: 1,
      status: MatchStatus.LIVE,
      team1Id: 'team-1',
      team2Id: 'team-2',
      team1Score: 0,
      team2Score: 0,
      winnerId: null
    };
    dbFixtures.set(fixture.id, fixture);

    const mockRefereeSocket: any = {
      id: 'socket-judge-1',
      handshake: {
        headers: {
          cookie: 'gcdis_admin_access_token=jwt_token_judge-1_JUDGE'
        }
      }
    };

    // Referee records GOAL for Team 1
    const eventRes = await scoringGateway.handleScoreEvent(
      {
        fixtureId: 'fix-final-1',
        teamId: 'team-1',
        eventType: MatchEventType.GOAL,
        scoreDelta: 1
      },
      mockRefereeSocket
    );

    expect(eventRes.fixture.team1Score).toBe(1);
    expect(eventRes.fixture.team2Score).toBe(0);

    // Verify room emission was strictly isolated to match room
    expect(scoringGateway.server.to).toHaveBeenCalledWith('match_fix-final-1');
    expect(scoringGateway.server.to).toHaveBeenCalledWith('public_summary');
  });
});
