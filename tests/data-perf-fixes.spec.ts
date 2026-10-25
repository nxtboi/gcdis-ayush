import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { UserRole, MatchEventType, MatchStatus } from '@gcdis/shared';
import { UploadsService, fileUrlForStorageKey } from '../apps/api/src/uploads/uploads.service';
import { UploadsController } from '../apps/api/src/uploads/uploads.controller';
import { CompetitionService } from '../apps/api/src/competition/competition.service';
import { ScoringGateway } from '../apps/api/src/scoring/scoring.gateway';

const validPdf = Buffer.from('%PDF-1.4\nID proof scan\n%%EOF');

function makeRes() {
  const res: any = {
    headers: {} as Record<string, string>,
    setHeader: jest.fn((k: string, v: string) => {
      res.headers[k] = v;
    })
  };
  return res;
}

describe('Data / performance fixes', () => {
  let tmpDir: string;
  const originalStorageDir = process.env.STORAGE_LOCAL_DIR;
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcdis-uploads-'));
    process.env.STORAGE_LOCAL_DIR = tmpDir;
    process.env.JWT_SECRET = 'data_perf_fixes_test_secret_value_32_chars+';
  });

  afterAll(() => {
    process.env.STORAGE_LOCAL_DIR = originalStorageDir;
    process.env.JWT_SECRET = originalJwtSecret;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Uploads: exact-match lookups and private-by-default visibility', () => {
    let assets: any[];
    let documents: any[];
    let members: any[];
    let mockPrisma: any;
    let service: UploadsService;
    let controller: UploadsController;

    const matches = (row: any, where: any) =>
      Object.entries(where).every(([k, v]) => {
        if (v !== null && typeof v === 'object') {
          throw new Error(`Non-equality filter used on ${k}: ${JSON.stringify(v)}`);
        }
        return row[k] === v;
      });

    beforeEach(() => {
      assets = [];
      documents = [];
      members = [];
      mockPrisma = {
        mediaAsset: {
          create: jest.fn(async ({ data }) => {
            const row = { id: `asset-${assets.length + 1}`, ...data };
            assets.push(row);
            return row;
          }),
          findFirst: jest.fn(async ({ where }) => assets.find((a) => matches(a, where)) || null),
          findUnique: jest.fn(async ({ where }) => assets.find((a) => a.id === where.id) || null)
        },
        document: { findFirst: jest.fn(async ({ where }) => documents.find((d) => matches(d, where)) || null) },
        teamMember: { findFirst: jest.fn(async ({ where }) => members.find((m) => matches(m, where)) || null) }
      };
      service = new UploadsService(mockPrisma, { logAction: jest.fn() } as any);
      controller = new UploadsController(service);
    });

    test('file lookups use exact equality on the full file URL (no LIKE/contains scans)', async () => {
      const upload = await service.processUpload(validPdf, 'doc.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'DOCUMENT');
      const key = path.basename(upload.fileUrl);

      await service.isAssetPrivate(key);
      await service.getFileStream(key).then((r) => r.stream.destroy());

      const expectedUrl = `/api/uploads/files/${key}`;
      expect(fileUrlForStorageKey(`../../${key}`)).toBe(expectedUrl);
      expect(mockPrisma.document.findFirst.mock.calls[0][0].where).toEqual({ fileUrl: expectedUrl });
      expect(mockPrisma.teamMember.findFirst.mock.calls[0][0].where).toEqual({ idProofUrl: expectedUrl });
      for (const [args] of mockPrisma.mediaAsset.findFirst.mock.calls) {
        expect(args.where.fileUrl).toBe(expectedUrl);
      }

      const code = fs.readFileSync(
        path.resolve(__dirname, '..', 'apps', 'api', 'src', 'uploads', 'uploads.service.ts'),
        'utf-8'
      );
      expect(code).not.toContain('contains:');
      expect(code).not.toContain('writeFileSync');
    });

    test('unlinked ID proof is private: records uploader, needs signed URL, served with private, no-store', async () => {
      const upload = await service.processUpload(validPdf, 'id.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'ID_PROOF');
      const key = path.basename(upload.fileUrl);

      expect(upload.isPublic).toBe(false);
      expect(assets[0]).toEqual(expect.objectContaining({ uploadedBy: 'cap-1', purpose: 'ID_PROOF', isPublic: false }));

      // Not linked to any Document / TeamMember yet, but still private
      expect(await service.isAssetPrivate(key)).toBe(true);

      // Anonymous access without a signed token is rejected
      await expect(controller.getFile(key, '', '', makeRes())).rejects.toThrow(ForbiddenException);

      // Another captain cannot obtain a signed URL
      await expect(service.generateSignedUrl(upload.assetId, 'cap-2', UserRole.TEAM_CAPTAIN)).rejects.toThrow(
        ForbiddenException
      );

      // The uploader can, and the file is then served with private, no-store caching
      const signed = await service.generateSignedUrl(upload.assetId, 'cap-1', UserRole.TEAM_CAPTAIN);
      const params = new URL(signed.url, 'http://localhost').searchParams;
      const res = makeRes();
      const pipe = jest.fn();
      jest.spyOn(service, 'getFileStream').mockResolvedValue({
        stream: { pipe } as any,
        mimeType: 'application/pdf',
        fileName: 'id.pdf'
      });
      await controller.getFile(key, params.get('token')!, params.get('expires')!, res);
      expect(pipe).toHaveBeenCalledWith(res);
      expect(res.headers['Cache-Control']).toBe('private, no-store');
    });

    test('public-purpose uploads stay public until linked to a registration', async () => {
      await expect(
        service.processUpload(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), 'x.png', 'cap-1', UserRole.TEAM_CAPTAIN, 'SPONSOR_LOGO')
      ).rejects.toThrow(ForbiddenException);

      // TEAM_LOGO was removed (security audit 2026-10): captains have no public upload purpose at all
      await expect(
        service.processUpload(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), 'x.png', 'cap-1', UserRole.TEAM_CAPTAIN, 'TEAM_LOGO')
      ).rejects.toThrow(BadRequestException);

      const logo = await service.processUpload(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
        'logo.png',
        'admin-1',
        UserRole.EVENT_ADMIN,
        'SPONSOR_LOGO'
      );
      const key = path.basename(logo.fileUrl);
      expect(await service.isAssetPrivate(key)).toBe(false);

      // Once linked as an ID proof it becomes private regardless of purpose
      members.push({ id: 'm-1', idProofUrl: logo.fileUrl });
      expect(await service.isAssetPrivate(key)).toBe(true);

      // Unknown files (no MediaAsset record) are private
      expect(await service.isAssetPrivate('unknown_file.pdf')).toBe(true);
    });
  });

  describe('Competition: concurrent score events are not lost', () => {
    test('logMatchEvent locks the fixture row before reading; concurrent goals both count', async () => {
      const fixtures = new Map<string, any>([
        [
          'fix-1',
          {
            id: 'fix-1',
            team1Id: 'team-1',
            team2Id: 'team-2',
            team1Score: 0,
            team2Score: 0,
            status: MatchStatus.LIVE,
            winnerId: null
          }
        ]
      ]);
      const callOrder: string[] = [];
      // Simulated row lock: held until the owning transaction finishes
      let lockTail: Promise<void> = Promise.resolve();

      const makeTx = (onLockAcquired: (release: () => void) => void) => ({
        $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
          callOrder.push('lock');
          expect(strings.join('?')).toMatch(/FOR UPDATE/);
          const prev = lockTail;
          let release!: () => void;
          lockTail = new Promise<void>((r) => (release = r));
          await prev;
          onLockAcquired(release);
          return 1;
        }),
        fixture: {
          findUnique: jest.fn(async ({ where }) => {
            callOrder.push('read');
            const f = fixtures.get(where.id);
            // Yield so that an unlocked implementation would interleave and lose an update
            await new Promise((r) => setTimeout(r, 5));
            return f ? { ...f } : null;
          }),
          update: jest.fn(async ({ where, data }) => {
            const updated = { ...fixtures.get(where.id), ...data };
            fixtures.set(where.id, updated);
            return updated;
          })
        },
        matchEvent: { create: jest.fn(async ({ data }) => ({ id: 'ev', ...data })) }
      });

      const mockPrisma: any = {
        $transaction: jest.fn(async (cb: any) => {
          let release: (() => void) | undefined;
          try {
            return await cb(makeTx((r) => (release = r)));
          } finally {
            release?.();
          }
        })
      };

      const service = new CompetitionService(mockPrisma);
      const goal = { fixtureId: 'fix-1', teamId: 'team-1', eventType: MatchEventType.GOAL, scoreDelta: 1 } as any;

      await Promise.all([service.logMatchEvent(goal, 'Judge A'), service.logMatchEvent(goal, 'Judge B')]);

      expect(fixtures.get('fix-1').team1Score).toBe(2);
      expect(fixtures.get('fix-1').winnerId).toBe('team-1');
      expect(callOrder[0]).toBe('lock');
    });
  });

  describe('Scoring gateway', () => {
    const fixture = { id: 'fix-1', matchNumber: 1, status: 'LIVE', team1Score: 1, team2Score: 0, winnerId: 'team-1' };
    const client: any = { id: 'sock-1', handshake: { auth: { token: 't' }, headers: {} } };

    function makeGateway(prisma?: any) {
      const competition: any = {
        findFixtureById: jest.fn().mockResolvedValue({ id: 'fix-1', team1Id: 'team-1', team2Id: 'team-2' }),
        logMatchEvent: jest.fn().mockResolvedValue(fixture)
      };
      const jwt: any = {
        verify: jest.fn().mockReturnValue({ sub: 'judge-1', sid: 'sess-1', role: UserRole.JUDGE, fullName: 'Judge' })
      };
      const gateway = new ScoringGateway(competition, jwt, prisma);
      const roomEmit = jest.fn();
      gateway.server = { to: jest.fn().mockReturnValue({ emit: roomEmit }), emit: jest.fn() } as any;
      return { gateway, roomEmit };
    }

    test('summary is emitted once to the summary room, never broadcast globally', async () => {
      const { gateway, roomEmit } = makeGateway();
      await gateway.handleScoreEvent(
        { fixtureId: 'fix-1', teamId: 'team-1', eventType: MatchEventType.GOAL, scoreDelta: 1 } as any,
        client
      );
      expect(gateway.server.emit).not.toHaveBeenCalled();
      expect(roomEmit.mock.calls.filter((c) => c[0] === 'summary_score_update')).toHaveLength(1);
    });

    test('revoked admin session cannot record scores when Prisma is available', async () => {
      const prisma: any = {
        session: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'sess-1',
            userId: 'judge-1',
            revokedAt: new Date(),
            isActive: false,
            expiresAt: new Date(Date.now() + 60000),
            user: { id: 'judge-1', role: 'JUDGE', fullName: 'Judge', isActive: true, mustChangePassword: false }
          })
        }
      };
      const { gateway } = makeGateway(prisma);
      await expect(
        gateway.handleScoreEvent(
          { fixtureId: 'fix-1', teamId: 'team-1', eventType: MatchEventType.GOAL, scoreDelta: 1 } as any,
          client
        )
      ).rejects.toThrow(WsException);
    });
  });
});
