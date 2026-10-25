import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ConflictException, ValidationPipe } from '@nestjs/common';
import { DocumentType, TeamMemberRole, UserRole } from '@gcdis/shared';
import { TeamsService, requireMemberName } from '../apps/api/src/teams/teams.service';
import { TeamMemberDto, UpdateTeamMemberDto, MEMBER_PHONE_REGEX } from '../apps/api/src/teams/dto/create-team.dto';
import { RegistrationsService } from '../apps/api/src/registrations/registrations.service';
import { AddDocumentDto } from '../apps/api/src/registrations/dto/add-document.dto';
import { buildRegistrationSteps } from '../apps/web/src/app/portal/_components/registration-steps';

const rootDir = path.join(__dirname, '..');
const portalDir = path.join(rootDir, 'apps', 'web', 'src', 'app', 'portal');
const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), 'utf-8');

const CAPTAIN = { id: 'cap-1', fullName: 'Asha Rao', email: 'asha@example.test', phone: '9876543210' };
const CATEGORY = { id: 'cat-d20', maxTeamSize: 10, isActive: true };

function teamsPrisma(existingMembers: any[] = [{ id: 'm0', email: CAPTAIN.email, memberRole: TeamMemberRole.CAPTAIN }]) {
  const prisma: any = {
    // No approved registration: the roster is not locked (security audit 2026-10, finding 1)
    registration: { findFirst: jest.fn().mockResolvedValue(null) },
    team: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'team-1', captainId: CAPTAIN.id, category: CATEGORY, members: existingMembers })
    },
    teamMember: {
      create: jest.fn(async ({ data }) => ({ id: 'new-member', ...data })),
      update: jest.fn(async ({ where, data }) => ({ id: where.id, ...data }))
    },
    mediaAsset: { findFirst: jest.fn().mockResolvedValue(null) },
    $executeRaw: jest.fn().mockResolvedValue(1)
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return prisma;
}

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

describe('Team Portal dashboard fixes', () => {
  describe('API: team members', () => {
    test('a whitespace-only member name is rejected instead of being stored as an empty string', async () => {
      expect(() => requireMemberName('   ')).toThrow(BadRequestException);
      expect(requireMemberName('  Rahul Sharma ')).toBe('Rahul Sharma');

      const prisma = teamsPrisma();
      const svc = new TeamsService(prisma);
      await expect(
        svc.addMember(CAPTAIN.id, 'team-1', { fullName: '   ', email: 'p@example.test', memberRole: TeamMemberRole.PILOT })
      ).rejects.toThrow(/full name/);
      await expect(svc.updateMember(CAPTAIN.id, 'team-1', 'm0', { fullName: ' ' })).rejects.toThrow(/full name/);
      expect(prisma.teamMember.create).not.toHaveBeenCalled();
      expect(prisma.teamMember.update).not.toHaveBeenCalled();
    });

    test('an empty phone on update clears the stored number; phones are stored trimmed', async () => {
      const prisma = teamsPrisma([
        { id: 'm0', email: CAPTAIN.email, memberRole: TeamMemberRole.CAPTAIN },
        { id: 'm1', email: 'p1@example.test', memberRole: TeamMemberRole.PILOT }
      ]);
      const svc = new TeamsService(prisma);
      await svc.updateMember(CAPTAIN.id, 'team-1', 'm1', { phone: '' });
      expect(prisma.teamMember.update).toHaveBeenLastCalledWith({ where: { id: 'm1' }, data: { mobile: '' } });

      await svc.addMember(CAPTAIN.id, 'team-1', {
        fullName: 'Pilot Two',
        email: 'p2@example.test',
        memberRole: TeamMemberRole.PILOT,
        phone: ' 98765 43210 '
      });
      expect(prisma.teamMember.create.mock.calls[0][0].data.mobile).toBe('98765 43210');
    });

    test('member phone numbers are validated (digits, optional +, spaces or hyphens); empty is allowed', async () => {
      for (const ok of ['9876543210', '+91 98765 43210', '0120-4806827', '']) expect(MEMBER_PHONE_REGEX.test(ok)).toBe(true);
      for (const bad of ['abc', '12', '98765abc10', '+', '9876543210-']) expect(MEMBER_PHONE_REGEX.test(bad)).toBe(false);

      await expect(
        pipe.transform(
          { fullName: 'A', email: 'a@example.test', memberRole: TeamMemberRole.PILOT, phone: 'abc' },
          { type: 'body', metatype: TeamMemberDto }
        )
      ).rejects.toBeDefined();
      await expect(pipe.transform({ phone: '' }, { type: 'body', metatype: UpdateTeamMemberDto })).resolves.toEqual({
        phone: ''
      });
    });

    test('limit errors are formal sentences and keep the FIDA figures', async () => {
      const full = Array.from({ length: 7 }, (_, i) => ({
        id: `m${i}`,
        email: `m${i}@example.test`,
        memberRole: i === 0 ? 'CAPTAIN' : 'PILOT'
      }));
      const svc = new TeamsService(teamsPrisma(full));
      await expect(
        svc.addMember(CAPTAIN.id, 'team-1', { fullName: 'Eighth', email: 'e@example.test', memberRole: TeamMemberRole.PILOT })
      ).rejects.toThrow('A team may have at most 7 members, including the captain; this change would bring the roster to 8.');
    });

    test('GET /teams/my-team returns the roster and documents in a stable order', async () => {
      const prisma: any = { team: { findFirst: jest.fn().mockResolvedValue(null) } };
      await new TeamsService(prisma).findCaptainTeam(CAPTAIN.id);
      const include = prisma.team.findFirst.mock.calls[0][0].include;
      expect(include.members.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
      expect(include.registrations.orderBy).toEqual({ submittedAt: 'desc' });
      expect(include.registrations.include.documents.orderBy).toEqual({ uploadedAt: 'desc' });
    });
  });

  describe('API: registration documents', () => {
    function registrationsService(overrides: { asset?: any; existingDoc?: any } = {}) {
      const prisma: any = {
        registration: {
          findUnique: jest.fn().mockResolvedValue({ id: 'reg-1', team: { captainId: CAPTAIN.id } })
        },
        mediaAsset: {
          findUnique: jest
            .fn()
            .mockResolvedValue(
              overrides.asset ?? { id: 'asset-1', uploadedBy: CAPTAIN.id, fileUrl: '/api/uploads/files/a.pdf', isPublic: false }
            )
        },
        document: {
          findFirst: jest.fn().mockResolvedValue(overrides.existingDoc ?? null),
          create: jest.fn(async ({ data }) => ({ id: 'doc-1', ...data }))
        }
      };
      const audit: any = { logAction: jest.fn().mockResolvedValue({}) };
      return { prisma, svc: new RegistrationsService(prisma, audit) };
    }

    test('linking the same upload twice is rejected with 409 instead of creating a duplicate document', async () => {
      const { prisma, svc } = registrationsService({ existingDoc: { id: 'doc-0' } });
      await expect(
        svc.addDocument('reg-1', DocumentType.INSTITUTION_NOC, 'asset-1', CAPTAIN.id, UserRole.TEAM_CAPTAIN)
      ).rejects.toThrow(ConflictException);
      expect(prisma.document.create).not.toHaveBeenCalled();
    });

    test('a public media upload cannot be submitted as a registration document', async () => {
      const { svc } = registrationsService({
        asset: { id: 'asset-2', uploadedBy: CAPTAIN.id, fileUrl: '/api/uploads/files/logo.png', isPublic: true }
      });
      await expect(svc.addDocument('reg-1', DocumentType.OTHER, 'asset-2', CAPTAIN.id, UserRole.TEAM_CAPTAIN)).rejects.toThrow(
        BadRequestException
      );
    });

    test('a first submission is stored as PENDING', async () => {
      const { svc } = registrationsService();
      const doc: any = await svc.addDocument(
        'reg-1',
        DocumentType.INSTITUTION_NOC,
        'asset-1',
        CAPTAIN.id,
        UserRole.TEAM_CAPTAIN,
        undefined,
        'noc.pdf'
      );
      expect(doc).toMatchObject({ status: 'PENDING', fileName: 'noc.pdf', fileUrl: '/api/uploads/files/a.pdf' });
    });

    test('document file names are length-limited', async () => {
      await expect(
        pipe.transform(
          { type: DocumentType.OTHER, assetId: 'asset-1', fileName: 'x'.repeat(256) },
          { type: 'body', metatype: AddDocumentDto }
        )
      ).rejects.toBeDefined();
    });
  });

  describe('Web: registration status timeline is derived from live data', () => {
    test('a freshly submitted registration completes step 1 only and marks the review as in progress', () => {
      const steps = buildRegistrationSteps({ submitted: true, status: 'SUBMITTED', isPaid: false, documents: [] });
      expect(steps.map((s) => s.state)).toEqual(['done', 'current', 'pending', 'pending', 'pending', 'pending']);
    });

    test('payment due, paid and accredited registrations progress the timeline', () => {
      // Registrations start at PAYMENT_PENDING; the administrative review follows payment
      const due = buildRegistrationSteps({ submitted: true, status: 'PAYMENT_PENDING', isPaid: false, documents: [] });
      expect(due.map((s) => s.title)).toEqual([
        'Team Registration Submitted',
        'Entry Fee Payment',
        'Administrative Review',
        'Document Verification',
        'Technical Inspection and Eligibility',
        'Accreditation and Match Allocation'
      ]);
      expect(due[1]).toMatchObject({
        state: 'current',
        desc: expect.stringMatching(/Payment is now due/)
      });
      expect(due[2].state).toBe('pending');
      expect(due[2].desc).not.toMatch(/has been reviewed/);
      const paid = buildRegistrationSteps({
        submitted: true,
        status: 'PAYMENT_VERIFIED',
        isPaid: true,
        documents: [{ status: 'PENDING' }]
      });
      expect(paid.map((s) => s.state)).toEqual(['done', 'done', 'current', 'pending', 'pending', 'pending']);
      expect(paid[3].desc).toMatch(/0 of 1 document verified/);
      const inReview = buildRegistrationSteps({ submitted: true, status: 'ADMINISTRATIVE_REVIEW', isPaid: true, documents: [] });
      expect(inReview[2]).toMatchObject({ state: 'current', desc: expect.stringMatching(/is reviewing/) });
      const reviewed = buildRegistrationSteps({ submitted: true, status: 'DOCUMENT_REVIEW', isPaid: true, documents: [{ status: 'PENDING' }] });
      expect(reviewed.map((s) => s.state)).toEqual(['done', 'done', 'done', 'current', 'pending', 'pending']);
      const accredited = buildRegistrationSteps({ submitted: true, status: 'ACCREDITED', isPaid: true, documents: [] });
      expect(accredited.every((s) => s.state === 'done')).toBe(true);
    });

    test('nothing is complete before the registration is submitted', () => {
      const steps = buildRegistrationSteps({ submitted: false, status: 'NOT_SUBMITTED', isPaid: false, documents: [] });
      expect(steps[0].state).toBe('current');
      expect(steps.filter((s) => s.state === 'done')).toHaveLength(0);
    });
  });

  describe('Web: API client session handling', () => {
    const originalEnv = process.env.NEXT_PUBLIC_API_URL;
    const g = global as any;
    let client: typeof import('../apps/web/src/lib/api-client');

    beforeEach(() => {
      jest.resetModules();
      process.env.NEXT_PUBLIC_API_URL = 'http://api.test/api';
      g.window = {
        dispatchEvent: jest.fn(),
        setTimeout: jest.fn(),
        URL: { createObjectURL: jest.fn(() => 'blob:x'), revokeObjectURL: jest.fn() }
      };
      g.document = {
        createElement: jest.fn(() => ({ click: jest.fn() })),
        body: { appendChild: jest.fn(), removeChild: jest.fn() }
      };
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      client = require('../apps/web/src/lib/api-client');
    });

    afterEach(() => {
      process.env.NEXT_PUBLIC_API_URL = originalEnv;
      delete g.window;
      delete g.document;
      delete g.fetch;
    });

    const response = (status: number, body: unknown = {}) =>
      ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
        text: async () => JSON.stringify(body),
        blob: async () => ({})
      }) as any;

    test('a 401 that cannot be refreshed raises ApiError(401) and notifies the page that the session expired', async () => {
      g.fetch = jest.fn().mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(401));
      const err: any = await client.fetchApi('/teams/my-team').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(client.ApiError);
      expect(err.status).toBe(401);
      expect(err.message).toBe(client.SESSION_EXPIRED_MESSAGE);
      expect(g.fetch.mock.calls[1][0]).toBe('http://api.test/api/auth/refresh');
      expect(g.window.dispatchEvent).toHaveBeenCalledTimes(1);
      expect(g.window.dispatchEvent.mock.calls[0][0].type).toBe(client.SESSION_EXPIRED_EVENT);
    });

    test('the anonymous session probe (/auth/me) does not announce an expired session', async () => {
      g.fetch = jest.fn().mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(401));
      await expect(client.fetchApi('/auth/me')).rejects.toThrow();
      expect(g.window.dispatchEvent).not.toHaveBeenCalled();
    });

    test('API errors carry their HTTP status and message', async () => {
      g.fetch = jest
        .fn()
        .mockResolvedValueOnce(response(409, { message: 'This file has already been submitted for your registration.' }));
      const err: any = await client.fetchApi('/registrations/r/documents', { method: 'POST' }).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 409, message: 'This file has already been submitted for your registration.' });
    });

    test('authenticated downloads refresh an expired access token and retry once', async () => {
      g.fetch = jest
        .fn()
        .mockResolvedValueOnce(response(401)) // file request with an expired access token
        .mockResolvedValueOnce(response(200)) // POST /auth/refresh
        .mockResolvedValueOnce(response(200)); // retried file request
      await client.downloadAuthenticatedFile('/payments/invoice/p1/pdf', 'invoice.pdf');
      expect(g.fetch).toHaveBeenCalledTimes(3);
      expect(g.fetch.mock.calls[1][0]).toBe('http://api.test/api/auth/refresh');
      expect(g.fetch.mock.calls[2][0]).toBe('http://api.test/api/payments/invoice/p1/pdf');
      // The object URL is released after a delay rather than synchronously (which can cancel the download).
      expect(g.window.URL.revokeObjectURL).not.toHaveBeenCalled();
      expect(g.window.setTimeout).toHaveBeenCalled();
    });
  });

  describe('Web: portal page wiring', () => {
    const page = read(portalDir, 'page.tsx');
    const motionHelpers = read(portalDir, '_components', 'motion.tsx');

    test('the dashboard returns to sign-in when the session expires', () => {
      expect(page).toContain('SESSION_EXPIRED_EVENT');
      expect(page).toContain('setAuthError(SESSION_EXPIRED_MESSAGE)');
    });

    test('the dashboard is usable on phones (navigation drawer instead of a fixed sidebar)', () => {
      expect(page).toContain('aria-label="Open navigation"');
      expect(page).toContain('hidden lg:block w-64');
    });

    test('animations respect the reduced-motion preference and tab switches never wait on an exit animation', () => {
      expect(page).toContain('<MotionConfig reducedMotion="user">');
      expect(page).not.toContain('mode="wait"');
      expect(motionHelpers).toContain('useReducedMotion');
      expect(motionHelpers).not.toMatch(/type:\s*'spring'/);
    });

    test('portal copy is formal: no exclamation marks in user-facing strings and the official contact address is used', () => {
      const dir = path.join(portalDir, '_components');
      const files = [path.join(portalDir, 'page.tsx'), ...fs.readdirSync(dir).map((f) => path.join(dir, f))];
      for (const file of files) {
        const code = fs.readFileSync(file, 'utf-8');
        // String literals and JSX text ending in "!" (excluding !== / != and logical negation)
        expect({ file, match: code.match(/['"`>][^'"`<>\n]*[A-Za-z.]![\s'"`<]/) }).toEqual({ file, match: null });
        expect(code).not.toMatch(/@gcdis\.(in|org)\b/);
      }
      expect(read(portalDir, '_components', 'types.ts')).toContain('SECRETARIAT_EMAIL = ORG_EMAIL');
    });
  });
});
