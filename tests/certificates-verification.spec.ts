import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { CertificatesService } from '../apps/api/src/certificates/certificates.service';
import { UserRole } from '@gcdis/shared';

describe('Cryptographic Certificates & Privacy Verification (Execution Engine)', () => {
  let certService: CertificatesService;
  let mockPrisma: any;
  let mockPdf: any;
  let certsDb: Map<string, any>;
  let membersDb: Map<string, any>;

  beforeEach(() => {
    certsDb = new Map();
    membersDb = new Map();

    mockPdf = {
      generateAccreditationPassPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 Accreditation Pass'))
    };

    mockPrisma = {
      teamMember: {
        findUnique: jest.fn(async ({ where }) => membersDb.get(where.id) || null)
      },
      certificate: {
        findUnique: jest.fn(async ({ where }) => {
          for (const c of certsDb.values()) {
            if (c.code === where.code) return c;
          }
          return null;
        }),
        create: jest.fn(async ({ data }) => {
          const c = { id: `cert-${certsDb.size + 1}`, ...data };
          certsDb.set(c.id, c);
          return c;
        })
      }
    };

    certService = new CertificatesService(mockPrisma as any, mockPdf as any);
  });

  test('1. verifyCode validates existing certificates and redacts PII', async () => {
    certsDb.set('c-1', {
      id: 'c-1',
      code: 'GCDIS-CERT-2026-A1B2',
      recipientName: 'Vikram Sarabhai',
      teamName: 'SkyForge',
      achievementTitle: '1st Place D40 National Championship',
      issuedDate: new Date('2026-11-15'),
      qrVerificationUrl: 'https://gcdis.in/verify/GCDIS-CERT-2026-A1B2',
      email: 'private.vikram@institution.edu',
      phone: '+919876543210',
      idProofUrl: 'https://storage.gcdis.in/private/aadhaar.pdf'
    });

    const res = await certService.verifyCode('gcdis-cert-2026-a1b2');

    expect(res.isValid).toBe(true);
    expect(res.certificate).toBeDefined();
    expect(res.certificate?.recipientName).toBe('Vikram Sarabhai');
    expect(res.certificate?.teamName).toBe('SkyForge');
    expect(res.qrDataUrl).toBeDefined();

    // Sensitive fields must NOT be returned in public verification response
    expect((res.certificate as any).email).toBeUndefined();
    expect((res.certificate as any).phone).toBeUndefined();
    expect((res.certificate as any).idProofUrl).toBeUndefined();
  });

  test('2. verifyCode returns isValid: false for unknown certificate code', async () => {
    const res = await certService.verifyCode('UNKNOWN-CODE-999');
    expect(res.isValid).toBe(false);
    expect(res.message).toContain('Certificate code not found');
  });

  test('3. generateMemberPassPdf enforces captain ownership and signs pass QR', async () => {
    membersDb.set('mem-1', {
      id: 'mem-1',
      fullName: 'Rohan Sharma',
      memberRole: 'PILOT',
      userId: 'user-pilot-1',
      team: {
        id: 'team-1',
        code: 'T26-001',
        name: 'AERO STRIKE',
        captainId: 'captain-1',
        institutionName: 'IIT Delhi',
        category: { name: 'AirMouse (D20 Drone Soccer)' },
        registrations: [{ status: 'APPROVED' }]
      }
    });

    // Unauthorized outsider captain trying to download Rohan's pass
    await expect(
      certService.generateMemberPassPdf('mem-1', 'other-captain-99', UserRole.TEAM_CAPTAIN)
    ).rejects.toThrow(ForbiddenException);

    // Legitimate captain downloading the pass
    const passBuffer = await certService.generateMemberPassPdf('mem-1', 'captain-1', UserRole.TEAM_CAPTAIN);
    expect(passBuffer).toBeDefined();
    expect(mockPdf.generateAccreditationPassPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: 'Rohan Sharma',
        teamName: 'AERO STRIKE',
        status: 'VERIFIED PASSPORT'
      })
    );
  });
});
