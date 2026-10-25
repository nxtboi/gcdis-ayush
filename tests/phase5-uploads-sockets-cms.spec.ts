import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import * as fs from 'fs';
import * as path from 'path';
import { UserRole, MatchEventType } from '@gcdis/shared';
import { UploadsService } from '../apps/api/src/uploads/uploads.service';
import { UploadsController } from '../apps/api/src/uploads/uploads.controller';
import { ScoringGateway, ScoreEventSchema } from '../apps/api/src/scoring/scoring.gateway';
import { CMSService } from '../apps/api/src/cms/cms.service';
import {
  sanitizeRichText,
  sanitizeUrl,
  validateBackgroundSettings,
  deepSanitizeContent
} from '../apps/api/src/common/utils/cms-sanitizer.util';
import {
  validateUploadedBuffer,
  stripImageMetadata,
  scanWithClamAv
} from '../apps/api/src/common/utils/upload-validator.util';

describe('Phase 5: Uploads, WebSocket Live Scoring & CMS Hardening', () => {
  const rootDir = path.resolve(__dirname, '..');
  const uploadsServicePath = path.join(rootDir, 'apps', 'api', 'src', 'uploads', 'uploads.service.ts');
  const uploadsControllerPath = path.join(rootDir, 'apps', 'api', 'src', 'uploads', 'uploads.controller.ts');
  const scoringGatewayPath = path.join(rootDir, 'apps', 'api', 'src', 'scoring', 'scoring.gateway.ts');
  const cmsServicePath = path.join(rootDir, 'apps', 'api', 'src', 'cms', 'cms.service.ts');

  describe('1. Uploads Hardening', () => {
    let mockPrisma: any;
    let mockAudit: any;
    let service: UploadsService;
    let controller: UploadsController;

    beforeEach(() => {
      mockPrisma = {
        mediaAsset: {
          create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'asset-1', ...data })),
          findFirst: jest.fn(),
          findUnique: jest.fn()
        },
        document: { findFirst: jest.fn() },
        teamMember: { findFirst: jest.fn() }
      };
      mockAudit = { logAction: jest.fn() };
      service = new UploadsService(mockPrisma, mockAudit);
      controller = new UploadsController(service);
    });

    test('UploadsController provides multipart streaming endpoint with limits', () => {
      const code = fs.readFileSync(uploadsControllerPath, 'utf-8');
      expect(code).toContain('uploadFileStream');
      expect(code).toContain('FileInterceptor');
      expect(code).toContain('fileSize: 25 * 1024 * 1024');
    });

    test('Role-based purposes: Only admins may upload CMS backgrounds', async () => {
      const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

      // Team Captain attempting to upload CMS_BACKGROUND must be rejected with 403 Forbidden
      await expect(
        service.processUpload(validPng, 'banner.png', 'user-cap-1', UserRole.TEAM_CAPTAIN, 'CMS_BACKGROUND')
      ).rejects.toThrow(ForbiddenException);

      // Super Admin or Event Admin uploading CMS_BACKGROUND succeeds
      const result = await service.processUpload(
        validPng,
        'banner.png',
        'admin-1',
        UserRole.SUPER_ADMIN,
        'CMS_BACKGROUND'
      );
      expect(result.assetId).toBe('asset-1');
    });

    test('Random storage keys: keys use UUID / random hex and never user-supplied names', async () => {
      const validPdf = Buffer.from('%PDF-1.4\nvalid content\n%%EOF');
      const userSuppliedName = 'MyVeryPersonalDocument.pdf';

      const result = await service.processUpload(
        validPdf,
        userSuppliedName,
        'cap-1',
        UserRole.TEAM_CAPTAIN,
        'DOCUMENT'
      );

      // Storage key in URL must not contain the original filename
      expect(result.fileUrl).not.toContain('MyVeryPersonalDocument');
      expect(result.fileUrl).toMatch(/\/api\/uploads\/files\/[a-f0-9\-]+_[a-f0-9]+\.pdf/i);
    });

    test('ClamAV / Malware scan rejects files containing infected payloads', async () => {
      const infectedBuffer = Buffer.from(
        '%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n%%EOF'
      );

      await expect(
        service.processUpload(infectedBuffer, 'infected.pdf', 'user-1', UserRole.TEAM_CAPTAIN, 'DOCUMENT')
      ).rejects.toThrow('Security Alert: Malicious file signature detected. Upload rejected.');
    });

    test('Re-encode / strip metadata: strips EXIF and metadata chunks from images', async () => {
      // JPEG with APP1 (EXIF marker 0xFFE1)
      const jpegWithExif = Buffer.from([
        0xff, 0xd8, // SOI
        0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x01, 0x02, // APP1 EXIF segment (10 bytes)
        0xff, 0xda, 0x00, 0x02, // SOS (Start of Scan)
        0xff, 0xd9 // EOI
      ]);

      const stripped = await stripImageMetadata(jpegWithExif, 'image/jpeg');
      // Stripped JPEG should not contain the APP1 EXIF marker 0xFF 0xE1
      const hasExifMarker = stripped.indexOf(Buffer.from([0xff, 0xe1])) !== -1;
      expect(hasExifMarker).toBe(false);
    });

    test('getFile sets nosniff and attachment disposition for non-images, inline for images', async () => {
      const mockRes: any = {
        headers: {},
        setHeader: jest.fn((k: string, v: string) => {
          mockRes.headers[k] = v;
        }),
        pipe: jest.fn()
      };

      jest.spyOn(service, 'isAssetPrivate').mockResolvedValue(false);

      // 1. Non-image (PDF): Must have attachment disposition
      jest.spyOn(service, 'getFileStream').mockResolvedValue({
        stream: { pipe: jest.fn() } as any,
        mimeType: 'application/pdf',
        fileName: 'reg_document.pdf'
      });

      await controller.getFile('file1.pdf', '', '', mockRes);
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="reg_document.pdf"'
      );

      // 2. Image (PNG): Must have inline disposition
      jest.spyOn(service, 'getFileStream').mockResolvedValue({
        stream: { pipe: jest.fn() } as any,
        mimeType: 'image/png',
        fileName: 'drone_logo.png'
      });

      await controller.getFile('file2.png', '', '', mockRes);
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'inline; filename="drone_logo.png"'
      );
    });
  });

  describe('2. WebSocket Live Scoring Hardening', () => {
    let mockCompetitionService: any;
    let mockJwt: any;
    let gateway: ScoringGateway;

    beforeEach(() => {
      mockCompetitionService = {
        findFixtureById: jest.fn(),
        logMatchEvent: jest.fn()
      };
      mockJwt = {
        verify: jest.fn()
      };
      gateway = new ScoringGateway(mockCompetitionService, mockJwt);
      gateway.server = {
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
        emit: jest.fn()
      } as any;
    });

    test('Authenticates from httpOnly admin cookie in the handshake', () => {
      const mockClientWithCookie: any = {
        handshake: {
          headers: {
            cookie: 'gcdis_admin_access_token=valid_admin_jwt_token_123; session_id=sess_456'
          }
        }
      };

      mockJwt.verify.mockReturnValue({
        sub: 'admin-1', sid: 'sess-1',
        email: 'referee@gcdis.org',
        role: UserRole.JUDGE,
        fullName: 'Judge Dredd'
      });

      const user = gateway.authenticateSocket(mockClientWithCookie);
      expect(mockJwt.verify).toHaveBeenCalledWith('valid_admin_jwt_token_123', expect.anything());
      expect(user.role).toBe(UserRole.JUDGE);
      expect(user.id).toBe('admin-1');
    });

    test('Rejects unauthenticated socket or non-referee role with WsException', async () => {
      // Missing token
      const mockClientUnauth: any = { handshake: { headers: {}, auth: {} } };
      expect(() => gateway.authenticateSocket(mockClientUnauth)).toThrow(WsException);

      // Non-referee role (e.g. TEAM_CAPTAIN)
      const mockClientCaptain: any = {
        handshake: { auth: { token: 'captain_token' }, headers: {} }
      };
      mockJwt.verify.mockReturnValue({ role: UserRole.TEAM_CAPTAIN, sub: 'cap-1', sid: 'sess-1' });

      await expect(
        gateway.handleScoreEvent(
          { fixtureId: 'fix-1', teamId: 'team-1', eventType: MatchEventType.GOAL, scoreDelta: 1 },
          mockClientCaptain
        )
      ).rejects.toThrow(WsException);
    });

    test('Zod validation rejects malformed score_event payload', async () => {
      const mockClient: any = {
        handshake: { auth: { token: 'admin_token' }, headers: {} }
      };
      mockJwt.verify.mockReturnValue({ role: UserRole.EVENT_ADMIN, sub: 'admin-1', sid: 'sess-1' });

      // Missing required fixtureId or negative scoreDelta
      await expect(
        gateway.handleScoreEvent(
          { fixtureId: '', teamId: 'team-1', eventType: MatchEventType.GOAL, scoreDelta: -5 } as any,
          mockClient
        )
      ).rejects.toThrow(WsException);
    });

    test('Verifies fixture exists and team is an active participant in the match', async () => {
      const mockClient: any = {
        id: 'client-ref-1',
        handshake: { auth: { token: 'admin_token' }, headers: {} }
      };
      mockJwt.verify.mockReturnValue({ role: UserRole.JUDGE, sub: 'judge-1', sid: 'sess-1' });

      // Fixture has Team A ('team-A') and Team B ('team-B')
      mockCompetitionService.findFixtureById.mockResolvedValue({
        id: 'fix-1',
        team1: { id: 'team-A' },
        team2: { id: 'team-B' }
      });

      // Third-party Team C ('team-C') is not in the match -> must throw WsException
      await expect(
        gateway.handleScoreEvent(
          { fixtureId: 'fix-1', teamId: 'team-C', eventType: MatchEventType.GOAL, scoreDelta: 1 },
          mockClient
        )
      ).rejects.toThrow('Specified team \'team-C\' is not a participant in this fixture');
    });

    test('Enforces rate limiting on rapid score event emissions', async () => {
      const mockClient: any = {
        id: 'rapid-client-1',
        handshake: { auth: { token: 'admin_token' }, headers: {} }
      };
      mockJwt.verify.mockReturnValue({ role: UserRole.SUPER_ADMIN, sub: 'admin-1', sid: 'sess-1' });
      mockCompetitionService.findFixtureById.mockResolvedValue({
        id: 'fix-1',
        team1: { id: 'team-A' },
        team2: { id: 'team-B' }
      });
      mockCompetitionService.logMatchEvent.mockResolvedValue({ id: 'fix-1' });

      // Emit 10 times (up to limit)
      for (let i = 0; i < 10; i++) {
        await gateway.handleScoreEvent(
          { fixtureId: 'fix-1', teamId: 'team-A', eventType: MatchEventType.GOAL, scoreDelta: 1 },
          mockClient
        );
      }

      // 11th emission within window exceeds rate limit
      await expect(
        gateway.handleScoreEvent(
          { fixtureId: 'fix-1', teamId: 'team-A', eventType: MatchEventType.GOAL, scoreDelta: 1 },
          mockClient
        )
      ).rejects.toThrow('Rate limit exceeded');
    });

    test('Emits detailed update ONLY to match room + minimal summary to public channel', async () => {
      const mockClient: any = {
        id: 'client-normal-1',
        handshake: { auth: { token: 'admin_token' }, headers: {} }
      };
      mockJwt.verify.mockReturnValue({ role: UserRole.JUDGE, sub: 'judge-1', sid: 'sess-1', fullName: 'Head Judge' });

      mockCompetitionService.findFixtureById.mockResolvedValue({
        id: 'fix-99',
        team1: { id: 'team-1' },
        team2: { id: 'team-2' }
      });

      const updatedFixture = {
        id: 'fix-99',
        matchNumber: 12,
        status: 'LIVE',
        team1Score: 4,
        team2Score: 2,
        winnerId: null,
        internalNotes: 'Private referee deliberation',
        judgeDetails: { secretCode: 'REF_99' }
      };
      mockCompetitionService.logMatchEvent.mockResolvedValue(updatedFixture);

      const roomEmitMock = jest.fn();
      gateway.server.to = jest.fn().mockReturnValue({ emit: roomEmitMock });

      await gateway.handleScoreEvent(
        { fixtureId: 'fix-99', teamId: 'team-1', eventType: MatchEventType.GOAL, scoreDelta: 1 },
        mockClient
      );

      // 1. Detailed match update goes to match room
      expect(gateway.server.to).toHaveBeenCalledWith('match_fix-99');
      expect(roomEmitMock).toHaveBeenCalledWith('match_updated', updatedFixture);

      // 2. Summary goes to public_summary room
      expect(gateway.server.to).toHaveBeenCalledWith('public_summary');
      expect(roomEmitMock).toHaveBeenCalledWith(
        'summary_score_update',
        expect.objectContaining({
          fixtureId: 'fix-99',
          team1Score: 4,
          team2Score: 2
        })
      );
      // Ensure private internal fields are not in the summary emission
      const summaryCall = roomEmitMock.mock.calls.find((call) => call[0] === 'summary_score_update');
      expect(summaryCall[1]).not.toHaveProperty('internalNotes');
      expect(summaryCall[1]).not.toHaveProperty('judgeDetails');
    });
  });

  describe('3. CMS Content & Background Hardening', () => {
    let mockPrisma: any;
    let mockAudit: any;
    let service: CMSService;

    beforeEach(() => {
      mockPrisma = {
        contentSection: {
          findUnique: jest.fn(),
          upsert: jest.fn().mockImplementation(({ update, create }) => Promise.resolve({ id: 'sec-1', ...update })),
          update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'sec-1', ...data }))
        },
        contentVersion: {
          create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'ver-1', ...data })),
          findUnique: jest.fn(),
          findMany: jest.fn()
        },
        $transaction: jest.fn(async (cb) => {
          if (Array.isArray(cb)) return Promise.all(cb);
          return cb(mockPrisma);
        })
      };
      mockAudit = { logAction: jest.fn() };
      service = new CMSService(mockPrisma, mockAudit);
    });

    test('Server-side rich text sanitizer strips script tags, iframes, and inline events', () => {
      const maliciousHtml = '<p>Welcome</p><script>alert("hacked")</script><iframe src="evil.com"></iframe><img src="x" onerror="stealCookies()">';
      const clean = sanitizeRichText(maliciousHtml);

      expect(clean).not.toContain('<script>');
      expect(clean).not.toContain('<iframe>');
      expect(clean).not.toContain('onerror=');
      expect(clean).toContain('<p>Welcome</p>');
    });

    test('Server-side URL sanitizer enforces HTTP/HTTPS and rejects javascript: URIs', () => {
      expect(sanitizeUrl('https://gcdis.org/rules')).toBe('https://gcdis.org/rules');
      expect(sanitizeUrl('/uploads/rules.pdf')).toBe('/uploads/rules.pdf');

      expect(() => sanitizeUrl('javascript:alert(1)')).toThrow(BadRequestException);
      expect(() => sanitizeUrl('data:text/html,<script>alert(1)</script>')).toThrow(BadRequestException);
      expect(() => sanitizeUrl('vbscript:msgbox(1)')).toThrow(BadRequestException);
    });

    test('Validates background settings ranges (focus 0-100, zoom, opacity 0-1, blur cap 20, brightness cap 200)', () => {
      // Valid settings
      expect(() =>
        validateBackgroundSettings({
          focusX: 50,
          focusY: 50,
          zoom: 120,
          overlayOpacity: 0.5,
          blurPx: 10,
          brightnessPct: 100,
          overlayColor: '#1a1a2e'
        })
      ).not.toThrow();

      // Invalid focusX (> 100)
      expect(() => validateBackgroundSettings({ focusX: 120 })).toThrow('focusX must be a number between 0 and 100');

      // Invalid overlayOpacity (> 1.0)
      expect(() => validateBackgroundSettings({ overlayOpacity: 1.5 })).toThrow('overlayOpacity must be a decimal between 0.0 and 1.0');

      // Invalid blurPx (> 20px cap)
      expect(() => validateBackgroundSettings({ blurPx: 35 })).toThrow('blurPx must be between 0 and 20px');

      // Invalid brightnessPct (> 200% cap)
      expect(() => validateBackgroundSettings({ brightnessPct: 250 })).toThrow('brightnessPct must be between 0% and 200%');

      // Invalid overlayColor hex
      expect(() => validateBackgroundSettings({ overlayColor: 'not-a-color' })).toThrow('overlayColor must be a valid hex color string');
    });

    test('saveSectionDraft sanitizes content and validates background settings before saving', async () => {
      const payloadWithXss = {
        description: 'Championship rules <script>attack()</script>',
        heroBackground: {
          focusX: 25,
          focusY: 75,
          blurPx: 5,
          overlayOpacity: 0.4
        }
      };

      await service.saveSectionDraft('hero', payloadWithXss, '<b>Title</b>', 'Subtitle', 'admin-1', 'admin@gcdis.org');

      // Verify that upsert was called with sanitized content
      expect(mockPrisma.contentSection.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            data: expect.objectContaining({
              description: 'Championship rules '
            })
          })
        })
      );
      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPDATE_CONTENT_SECTION_DRAFT'
        })
      );
    });

    test('publishSection creates immutable ContentVersion snapshot and records audit entry', async () => {
      mockPrisma.contentSection.findUnique.mockResolvedValue({
        id: 'sec-rules',
        key: 'rules',
        title: 'Rules',
        data: { text: 'Fair play' },
        versions: [{ versionNumber: 1 }]
      });

      const res = await service.publishSection('rules', 'Updated drone specs', 'admin-1', 'admin@gcdis.org');

      expect(mockPrisma.contentVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sectionId: 'sec-rules',
            versionNumber: 2,
            changeNote: 'Updated drone specs'
          })
        })
      );
      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PUBLISH_CONTENT_SECTION'
        })
      );
    });

    test('rollbackSection reverts section to previous version and logs audit entry', async () => {
      mockPrisma.contentSection.findUnique.mockResolvedValue({
        id: 'sec-rules',
        key: 'rules',
        data: { text: 'New broken rules' }
      });

      mockPrisma.contentVersion.findUnique.mockResolvedValue({
        id: 'ver-1',
        title: 'Original Rules',
        data: { text: 'Original stable rules' }
      });

      await service.rollbackSection('rules', 1, 'admin-1', 'admin@gcdis.org');

      expect(mockPrisma.contentSection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: 'rules' },
          data: expect.objectContaining({
            title: 'Original Rules',
            data: { text: 'Original stable rules' }
          })
        })
      );
      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ROLLBACK_CONTENT_SECTION'
        })
      );
    });
  });
});
