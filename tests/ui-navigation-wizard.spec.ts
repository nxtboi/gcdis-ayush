import * as fs from 'fs';
import * as path from 'path';
import { buildTeamJourney } from '../apps/web/src/app/portal/_components/team-journey';
import {
  CITY_MAX,
  INSTITUTE_MAX,
  TEAM_NAME_MAX,
  toSafeDraft,
  validateCaptain,
  validateCategory,
  validateTeamDetails
} from '../apps/web/src/app/portal/_components/registration-validation';

const rootDir = path.resolve(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(rootDir, ...p), 'utf-8');
const portal = (...p: string[]) => read('apps', 'web', 'src', 'app', 'portal', ...p);
const admin = (...p: string[]) => read('apps', 'admin', 'src', 'app', ...p);

describe('Portal: team journey', () => {
  const base = { teamSaved: false, emailVerified: false as boolean | null, memberCount: 0, submitted: false, status: 'NOT_SUBMITTED', isPaid: false };

  test('a new captain starts at "Team created"', () => {
    const steps = buildTeamJourney(base);
    expect(steps.map((s) => s.id)).toEqual(['team', 'email', 'members', 'submitted', 'payment', 'inspection', 'approved']);
    expect(steps[0].state).toBe('current');
    expect(steps.slice(1).every((s) => s.state === 'pending')).toBe(true);
  });

  test('steps tick from loaded data and the first open step is current', () => {
    const steps = buildTeamJourney({ ...base, teamSaved: true, emailVerified: true, memberCount: 2, submitted: true, status: 'SUBMITTED' });
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'current', 'done', 'pending', 'pending', 'pending']);
    expect(steps[2].tab).toBe('members');
  });

  test('payment, inspection and approval follow the registration status', () => {
    const paid = buildTeamJourney({ ...base, teamSaved: true, emailVerified: true, memberCount: 5, submitted: true, status: 'PAYMENT_VERIFIED', isPaid: true });
    expect(paid.find((s) => s.id === 'payment')?.state).toBe('done');
    expect(paid.find((s) => s.id === 'inspection')?.state).toBe('current');
    const approved = buildTeamJourney({ ...base, teamSaved: true, emailVerified: true, memberCount: 6, submitted: true, status: 'APPROVED', isPaid: true });
    expect(approved.every((s) => s.state === 'done')).toBe(true);
  });
});

describe('Portal: registration wizard validation mirrors the API limits', () => {
  test('team details: required, at most 80 / 160 / 80 characters (CreateTeamDto)', () => {
    expect([TEAM_NAME_MAX, INSTITUTE_MAX, CITY_MAX]).toEqual([80, 160, 80]);
    expect(Object.keys(validateTeamDetails({ teamName: ' ', institute: '', city: '' }))).toEqual(['teamName', 'institute', 'city']);
    expect(validateTeamDetails({ teamName: 'x'.repeat(81), institute: 'I', city: 'C' }).teamName).toMatch(/must not exceed 80/);
    expect(validateTeamDetails({ teamName: 'Aero', institute: 'I'.repeat(160), city: 'C'.repeat(80) })).toEqual({});
  });

  test('category is required', () => {
    expect(validateCategory('').categoryId).toBeTruthy();
    expect(validateCategory('abc')).toEqual({});
  });

  test('captain: name, 10-digit mobile, email, password policy and confirmation', () => {
    const ok = {
      captainName: 'Priya Sharma',
      captainEmail: 'captain.smith@example.test',
      captainMobile: '9876543210',
      password: 'Harbour.Lights2026',
      confirmPassword: 'Harbour.Lights2026'
    };
    expect(validateCaptain(ok)).toEqual({});
    const bad = validateCaptain({ captainName: 'P', captainEmail: 'nope', captainMobile: '12345', password: 'short', confirmPassword: 'other' });
    expect(Object.keys(bad).sort()).toEqual(['captainEmail', 'captainMobile', 'captainName', 'confirmPassword', 'password']);
    expect(bad.password).toMatch(/at least 12 characters/);
  });

  test('drafts never keep passwords', () => {
    const draft = toSafeDraft({ teamName: 'Aero', password: 'secret-value', confirmPassword: 'secret-value', captainEmail: 'a@b.test' });
    expect(draft).toEqual({ teamName: 'Aero', captainEmail: 'a@b.test' });
  });
});

describe('UI wiring', () => {
  test('wizard: four steps, aria-describedby errors, focus on the first error, autosaved draft with try/catch', () => {
    const parts = portal('_components', 'WizardParts.tsx');
    expect(parts).toContain('aria-current={isCurrent ? \'step\' : undefined}');
    expect(parts).toContain('role="progressbar"');
    const setup = portal('_components', 'TeamSetupPanel.tsx');
    expect(setup).toContain('aria-describedby={describedBy(');
    expect(setup).toContain('focusFirstError(');
    const draft = portal('_components', 'wizard-draft.ts');
    expect(draft.match(/try \{/g)?.length).toBeGreaterThanOrEqual(3);
    expect(portal('_components', 'RegisterWizard.tsx')).toContain('handleRegisterSubmit(e);');
  });

  test('portal: grouped navigation, journey and a focus-trapped drawer', () => {
    const page = portal('page.tsx');
    expect(page).toContain('useFocusTrap(drawerRef, navOpen, closeNav);');
    expect(page).toContain('<PortalSidebar');
    const sidebar = portal('_components', 'PortalSidebar.tsx');
    expect(sidebar).toContain('buildTeamJourney(');
    expect(sidebar).toContain("aria-current={active ? 'page' : undefined}");
  });

  test('console: grouped sidebar, collapse remembered with try/catch, drawer and awaiting-review badge from the existing list endpoint', () => {
    const page = admin('page.tsx');
    expect(page).toContain("{ id: 'event', label: 'Event' }");
    expect(page).toContain("{ id: 'website', label: 'Website' }");
    expect(page).toContain("{ id: 'administration', label: 'Administration' }");
    expect(page).toContain('<AdminSidebar');
    const sidebar = admin('_components', 'AdminSidebar.tsx');
    expect(sidebar).toContain("aria-current={isActive ? 'page' : undefined}");
    expect(sidebar).toContain('window.localStorage.getItem(COLLAPSE_KEY)');
    expect(sidebar).toContain('role="tooltip"');
    expect(sidebar).toContain('useFocusTrap(drawerRef, mobileOpen, onMobileClose);');
    expect(admin('_components', 'AwaitingReviewBadge.tsx')).toContain("/registrations?status=${status}&limit=1&offset=0");
    expect(admin('_components', 'AwaitingReviewBadge.tsx')).toContain("['PAYMENT_VERIFIED', 'SUBMITTED']");
  });
});
