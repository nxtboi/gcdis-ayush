import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ALLOWED_MATCH_TRANSITIONS, ALLOWED_REGISTRATION_TRANSITIONS, MatchEventType, UserRole } from '@gcdis/shared';
import { CompetitionController, FixtureEventSchema, LogEventSchema } from '../apps/api/src/competition/competition.controller';
import { InspectionService, measurementOf } from '../apps/api/src/inspection/inspection.service';
import { CMSService } from '../apps/api/src/cms/cms.service';
import {
  MATCH_TRANSITIONS,
  REGISTRATION_TRANSITIONS,
  canScore,
  formatInr,
  hasTwoFactor,
  isChecklistItemComplete,
  nextRegistrationStatuses,
  roleLabel,
  statusLabel
} from '../apps/admin/src/app/_components/types';
import { formalMessage } from '../apps/admin/src/lib/messages';

const adminDir = path.join(__dirname, '..', 'apps', 'admin');
const read = (...parts: string[]) => fs.readFileSync(path.join(adminDir, ...parts), 'utf-8');
const componentsDir = path.join(adminDir, 'src', 'app', '_components');
const consoleSources = () => [
  read('src', 'app', 'page.tsx'),
  ...fs.readdirSync(componentsDir).map((f) => fs.readFileSync(path.join(componentsDir, f), 'utf-8'))
];

const FIXTURE_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';

describe('Staff console fixes', () => {
  describe('Registration status changes', () => {
    test('the console sends targetStatus (the API rejected the former { status } body with 400)', () => {
      const page = read('src', 'app', 'page.tsx');
      expect(page).toContain('JSON.stringify(reason ? { targetStatus, reason } : { targetStatus })');
      expect(page).not.toContain('JSON.stringify({ status: targetStatus })');
    });

    test('the console transition table mirrors the shared state machine', () => {
      expect(REGISTRATION_TRANSITIONS).toEqual(ALLOWED_REGISTRATION_TRANSITIONS);
      expect(MATCH_TRANSITIONS).toEqual(ALLOWED_MATCH_TRANSITIONS);
      // Only permitted next statuses are offered: SUBMITTED cannot jump to APPROVED
      expect(nextRegistrationStatuses('SUBMITTED')).not.toContain('APPROVED');
      expect(nextRegistrationStatuses('ELIGIBILITY_REVIEW')).toContain('APPROVED');
      expect(nextRegistrationStatuses('UNKNOWN')).toEqual([]);
    });
  });

  describe('Match scoring route (the console called a route that returned 404)', () => {
    const service = {
      logMatchEvent: jest.fn(async (input: any) => ({ id: input.fixtureId, team1Score: 1 })),
      transitionMatchStatus: jest.fn(async (id: string, status: string) => ({ id, status }))
    };
    const controller = new CompetitionController(service as any);
    const req = { user: { fullName: 'QA Judge' } };

    beforeEach(() => jest.clearAllMocks());

    test('POST fixtures/:id/event records the event for the fixture in the URL', async () => {
      await controller.recordFixtureEvent(req, FIXTURE_ID, { teamId: TEAM_ID, eventType: 'GOAL', scoreDelta: 1 });
      expect(service.logMatchEvent).toHaveBeenCalledWith(
        { teamId: TEAM_ID, eventType: MatchEventType.GOAL, scoreDelta: 1, fixtureId: FIXTURE_ID },
        'QA Judge'
      );
    });

    test('invalid bodies are rejected with 400 before reaching the service', async () => {
      await expect(controller.recordFixtureEvent(req, FIXTURE_ID, { teamId: 'x', eventType: 'GOAL' })).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(controller.recordFixtureEvent(req, FIXTURE_ID, { teamId: TEAM_ID, eventType: 'GOAL', scoreDelta: 50 })).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(controller.logMatchEvent(req, { teamId: TEAM_ID, eventType: 'GOAL' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.transitionStatus(FIXTURE_ID, { targetStatus: 'BOGUS' })).rejects.toBeInstanceOf(BadRequestException);
      expect(service.logMatchEvent).not.toHaveBeenCalled();
      expect(service.transitionMatchStatus).not.toHaveBeenCalled();
    });

    test('schemas default scoreDelta to 1 and require a fixture id on the legacy route', () => {
      expect(FixtureEventSchema.parse({ teamId: TEAM_ID, eventType: 'GOAL' }).scoreDelta).toBe(1);
      expect(LogEventSchema.safeParse({ teamId: TEAM_ID, eventType: 'GOAL' }).success).toBe(false);
    });

    test('the console only enables scoring for live or paused matches', () => {
      expect(canScore('LIVE')).toBe(true);
      expect(canScore('PAUSED')).toBe(true);
      expect(canScore('SCHEDULED')).toBe(false);
      expect(read('src', 'app', 'page.tsx')).toContain('`/competition/fixtures/${activeFixture.id}/status`');
    });
  });

  describe('Technical inspection recording', () => {
    const makeService = (status: string) => {
      const prisma = { technicalInspection: { create: jest.fn(async ({ data }: any) => ({ id: 'insp-1', ...data })) } };
      const registrations = {
        findById: jest.fn(async () => ({ id: 'reg-1', registrationCode: 'GCDIS-QA-1', status })),
        transitionStatus: jest.fn(async () => ({}))
      };
      return { service: new InspectionService(prisma as any, registrations as any), prisma, registrations };
    };
    const input = {
      registrationId: 'reg-1',
      checks: {
        diameterMm: { value: 200, passed: true },
        weightGrams: { value: 105, passed: true },
        killSwitchLatencySeconds: { value: 0.12, passed: true }
      }
    };

    test('measurements sent by the console are stored (they were previously recorded as 0)', async () => {
      const { service, prisma, registrations } = makeService('TECHNICAL_INSPECTION');
      await service.recordInspection('user-1', 'QA Inspector', input as any, UserRole.SUPER_ADMIN, 'qa@example.test');
      expect(prisma.technicalInspection.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ diameterMm: 200, weightGrams: 105, failsafeLatencySec: 0.12, status: 'PASSED' }) })
      );
      expect(registrations.transitionStatus).toHaveBeenCalledWith(
        'reg-1',
        'ELIGIBILITY_REVIEW',
        UserRole.SUPER_ADMIN,
        'user-1',
        'qa@example.test',
        'Technical inspection passed'
      );
    });

    test('legacy check keys are still accepted', () => {
      expect(measurementOf({ sphereDiameterMm: { value: '395' } }, 'diameterMm')).toBe(395);
      expect(measurementOf({ allUpWeightGrams: { value: 900 } }, 'weightGrams')).toBe(900);
      expect(measurementOf({}, 'failsafeLatencySec')).toBe(0);
    });

    test('a registration not awaiting inspection is rejected before any record is written', async () => {
      const { service, prisma, registrations } = makeService('SUBMITTED');
      await expect(service.recordInspection('user-1', 'QA Inspector', input as any)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.technicalInspection.create).not.toHaveBeenCalled();
      expect(registrations.transitionStatus).not.toHaveBeenCalled();
    });

    test('a role that may not record outcomes is rejected before any record is written', async () => {
      const { service, prisma } = makeService('TECHNICAL_INSPECTION');
      await expect(service.recordInspection('user-1', 'QA Judge', input as any, UserRole.JUDGE)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.technicalInspection.create).not.toHaveBeenCalled();
    });

    test('the console lists only registrations awaiting inspection', () => {
      expect(read('src', 'app', 'page.tsx')).toContain("adminFetch('/registrations?status=TECHNICAL_INSPECTION&limit=100')");
    });
  });

  describe('CMS checklist and audit attribution', () => {
    const makeCms = (prizes: { amount: number; isConfirmed: boolean }[]) => {
      const audit = { logAction: jest.fn(async () => ({})) };
      const prisma: any = {
        prize: { findMany: jest.fn(async () => prizes) },
        siteSetting: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
        contentSection: {
          findUnique: jest.fn(async () => ({ id: 's1', key: 'hero', isPublished: false, versions: [] })),
          upsert: jest.fn(async ({ update }: any) => ({ id: 's1', ...update }))
        },
        event: { findMany: jest.fn(async () => []) }
      };
      return { cms: new CMSService(prisma, audit as any), audit };
    };

    test('every checklist item reports Complete or Needs input with a consistent isComplete flag', async () => {
      const { cms } = makeCms([{ amount: 120000, isConfirmed: true }]);
      const checklist = await cms.getOperationalChecklist();
      for (const item of checklist.items) {
        expect(['Complete', 'Needs input']).toContain(item.status);
        expect(item.isComplete).toBe(item.status === 'Complete');
      }
      const prizes = checklist.items.find((i) => i.id === 'prizes_remainder');
      expect(prizes?.detail).toBe('Confirmed prizes exceed the INR 1,00,000 prize pool by INR 20,000.');
      expect((await cms.getPrizes()).unallocatedStatus).toBe('Over-allocated');
    });

    test("the audit log records the editor's actual role, not a hard-coded SUPER_ADMIN", async () => {
      const { cms, audit } = makeCms([]);
      await cms.saveSectionDraft('hero', { headline: 'QA' }, 'QA Hero', undefined, 'user-2', 'editor@example.test', 'EVENT_ADMIN');
      expect(audit.logAction).toHaveBeenCalledWith(expect.objectContaining({ actorRole: 'EVENT_ADMIN', actorEmail: 'editor@example.test' }));
    });
  });

  describe('Console presentation helpers', () => {
    test('two-factor status is read from isTwoFactorEnabled (the list always showed "NO")', () => {
      expect(hasTwoFactor({ id: '1', email: 'a', isTwoFactorEnabled: true })).toBe(true);
      expect(hasTwoFactor({ id: '1', email: 'a', twoFactorEnabled: true })).toBe(true);
      expect(hasTwoFactor({ id: '1', email: 'a' })).toBe(false);
    });

    test('checklist items marked "Configured" by older APIs count as complete', () => {
      expect(isChecklistItemComplete({ id: 'x', title: 'x', status: 'Configured' })).toBe(true);
      expect(isChecklistItemComplete({ id: 'x', title: 'x', status: 'Complete', isComplete: false })).toBe(false);
    });

    test('labels and amounts are formatted formally', () => {
      expect(statusLabel('PAYMENT_PENDING')).toBe('Payment Pending');
      expect(statusLabel(undefined)).toBe('Not Specified');
      expect(roleLabel('EVENT_ADMIN')).toBe('Event Administrator');
      expect(roleLabel(null)).toBe('System');
      expect(formatInr(100000)).toBe('INR 1,00,000');
    });

    test('API messages are shown as formal, complete sentences', () => {
      expect(formalMessage('Invalid email or password')).toBe('The email address or password is incorrect.');
      expect(formalMessage('Current password does not match')).toBe('The current password is incorrect.');
      expect(formalMessage('HTTP 404: Not Found')).toBe('The requested record could not be found.');
      expect(formalMessage('something went wrong!')).toBe('Something went wrong.');
    });
  });

  describe('Console behaviour and motion', () => {
    test('no window.confirm or alert dialogues remain in the console', () => {
      for (const source of consoleSources()) {
        const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(code).not.toMatch(/\b(window\.)?confirm\(/);
        expect(code).not.toMatch(/\balert\(/);
      }
    });

    test('framer-motion is a declared dependency and motion honours prefers-reduced-motion', () => {
      const pkg = JSON.parse(read('package.json'));
      expect(pkg.dependencies['framer-motion']).toBeDefined();
      expect(read('src', 'app', '_components', 'motion.tsx')).toContain('reducedMotion="user"');
      expect(read('src', 'app', 'globals.css')).toMatch(/prefers-reduced-motion: reduce\)\s*{\s*\.admin-skeleton { animation: none; }/);
    });

    test('dialogues trap focus and close on Escape', () => {
      const modal = read('src', 'app', '_components', 'Modal.tsx');
      expect(modal).toContain('aria-modal="true"');
      expect(modal).toContain("event.key === 'Escape'");
      expect(modal).toContain("event.key !== 'Tab'");
    });

    test('the audit action filter is applied on submit, not on every keystroke', () => {
      const auditTab = read('src', 'app', '_components', 'AuditTab.tsx');
      expect(auditTab).toContain('const [actionDraft, setActionDraft]');
      expect(auditTab).toContain('onSubmit={applyFilters}');
    });

    test('console copy contains no exclamation marks or informal wording', () => {
      for (const code of consoleSources()) {
        // String literals and JSX text only: strip comments and !== / != / !x operators
        const text = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(text).not.toMatch(/['">][^'"<>{}]*[A-Za-z]![ '"<]/);
        expect(text).not.toMatch(/\b(Oops|Whoops|Awesome|Yay)\b/);
      }
    });
  });

  describe('Audit CSV export session handling', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
    });

    test('a 401 is refreshed once and then ends the session instead of showing a raw HTTP error', async () => {
      process.env.NEXT_PUBLIC_API_URL = 'http://api.test/api';
      let client: typeof import('../apps/admin/src/lib/api-client');
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        client = require('../apps/admin/src/lib/api-client');
      });
      const calls: string[] = [];
      global.fetch = jest.fn(async (url: RequestInfo | URL) => {
        calls.push(String(url));
        return { ok: false, status: 401, statusText: '401', json: async () => ({}) } as Response;
      }) as typeof fetch;
      const handler = jest.fn();
      client!.setSessionExpiredHandler(handler);
      await expect(client!.downloadAuditCsv({ action: 'LOGIN' })).rejects.toBeInstanceOf(client!.SessionExpiredError);
      expect(calls).toEqual(['http://api.test/api/audit/export?format=csv&action=LOGIN', 'http://api.test/api/auth/refresh']);
      expect(handler).toHaveBeenCalled();
    });
  });
});
