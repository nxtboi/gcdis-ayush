import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UserRole } from '@gcdis/shared';
import { AUDIENCE_ROLES_KEY } from '../apps/api/src/auth/audience-roles.guard';
import { ROLES_KEY } from '../apps/api/src/auth/roles.decorator';
import { RegistrationsController } from '../apps/api/src/registrations/registrations.controller';
import { RegistrationsService } from '../apps/api/src/registrations/registrations.service';
import { UploadsController } from '../apps/api/src/uploads/uploads.controller';
import { DOCUMENT_FEEDBACK_MAX_LENGTH } from '../apps/api/src/registrations/dto/verify-document.dto';

// The portal types module imports the site constants through the web app's "@/" alias
jest.mock('@/lib/site', () => jest.requireActual('../apps/web/src/lib/site'), { virtual: true });

/**
 * Staff review of team-uploaded documents: the registration detail dialogue in the staff console, the
 * signed-URL file view, approve / reject requests (with the anti-CSRF header), inspector read-only access,
 * the minimal API addition (asset ids on the staff detail view) and the captain's view of the feedback.
 */

const API = 'http://localhost:4000/api';
process.env.NEXT_PUBLIC_API_URL = API;

const root = path.resolve(__dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), 'utf-8');
const components = (name: string) => read('apps', 'admin', 'src', 'app', '_components', name);

// Loaded after NEXT_PUBLIC_API_URL is set: the console API client reads it once at module load
// eslint-disable-next-line @typescript-eslint/no-var-requires
const review = require('../apps/admin/src/app/_components/documentReview') as typeof import('../apps/admin/src/app/_components/documentReview');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RegistrationDetailView } = require('../apps/admin/src/app/_components/RegistrationDetailDialog') as typeof import('../apps/admin/src/app/_components/RegistrationDetailDialog');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DocumentList } = require('../apps/web/src/app/portal/_components/UploadsTab') as typeof import('../apps/web/src/app/portal/_components/UploadsTab');

const DETAIL = {
  id: 'reg-1',
  registrationCode: 'GCDIS-2026-0042',
  status: 'DOCUMENT_REVIEW',
  category: { name: 'Class 40 (D40) Drone Soccer' },
  team: {
    name: 'Sky Strikers',
    code: 'TEAM-SKY',
    institutionName: 'Example Institute of Technology',
    city: 'Greater Noida',
    captain: { fullName: 'Asha Captain', email: 'asha@example.test' },
    members: [
      { id: 'm1', fullName: 'Ravi Pilot', email: 'ravi@example.test', memberRole: 'PILOT', idProofUrl: '/api/uploads/files/a.pdf', idProofAssetId: '11111111-1111-4111-8111-111111111111' },
      { id: 'm2', fullName: 'Neha Mechanic', email: 'neha@example.test', memberRole: 'TEAM_MEMBER', idProofUrl: null }
    ]
  },
  documents: [
    { id: 'd1', type: 'INSTITUTION_NOC', fileName: 'noc.pdf', status: 'PENDING', uploadedAt: '2026-10-10T10:00:00.000Z', assetId: '22222222-2222-4222-8222-222222222222', mimeType: 'application/pdf' },
    { id: 'd2', type: 'INSURANCE', fileName: 'insurance.png', status: 'REJECTED', feedback: 'The policy number is not legible.', uploadedAt: '2026-10-11T10:00:00.000Z', assetId: '33333333-3333-4333-8333-333333333333', mimeType: 'image/png' },
    { id: 'd3', type: 'TECH_PASSPORT', fileName: 'passport.pdf', status: 'VERIFIED', uploadedAt: '2026-10-12T10:00:00.000Z', assetId: null }
  ],
  payments: [{ id: 'p1', status: 'SUCCESS', amount: 21000, currency: 'INR', paidAt: '2026-10-09T10:00:00.000Z' }]
};

const noop = () => undefined;
function renderView(props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    React.createElement(RegistrationDetailView, {
      detail: DETAIL as any,
      canDecide: true,
      onRefresh: noop,
      onViewFile: noop,
      onStartDecision: noop,
      onCancelDecision: noop,
      onFeedbackChange: noop,
      onSubmitDecision: noop,
      ...props
    })
  );
}

function mockFetch(body: unknown, status = 200) {
  const fn = jest.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body
  }));
  (global as any).fetch = fn;
  return fn;
}

afterEach(() => {
  delete (global as any).fetch;
  jest.restoreAllMocks();
});

describe('Registration detail dialogue wiring (staff console)', () => {
  const tab = components('RegistrationsTab.tsx');
  const dialog = components('RegistrationDetailDialog.tsx');
  const page = read('apps', 'admin', 'src', 'app', 'page.tsx');

  test('each registration row has a View / Documents button that opens the detail dialogue', () => {
    expect(tab).toContain("import RegistrationDetailDialog from './RegistrationDetailDialog';");
    expect(tab).toContain('onClick={() => setDetailId(reg.id)}');
    expect(tab).toContain('View / Documents');
    expect(tab).toMatch(/<RegistrationDetailDialog\s+registrationId=\{detailId\}\s+role=\{role\}\s+onClose=\{\(\) => setDetailId\(null\)\}\s+onChanged=\{loadRegistrations\}/);
    expect(page).toMatch(/statusFilter=\{regStatusFilter\}\s+role=\{currentUser\?\.role\}/);
  });

  test('rows show "Docs pending: N" and a Document Review quick filter is offered', () => {
    expect(tab).toContain('const docsPending = pendingDocumentCount(reg);');
    expect(tab).toContain('Docs pending: {docsPending}');
    expect(tab).toContain("const DOCUMENT_REVIEW_STATUS = 'DOCUMENT_REVIEW';");
    expect(tab).toContain('aria-pressed={statusFilter === DOCUMENT_REVIEW_STATUS}');
    expect(review.pendingDocumentCount({ documents: DETAIL.documents as any })).toBe(1);
    expect(review.pendingDocumentCount({})).toBe(0);
  });

  test('the dialogue reuses the accessible Modal, loads GET /registrations/:id and refreshes the list and badge after a decision', () => {
    expect(dialog).toMatch(/import \{ Modal, BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY \} from '\.\/Modal';/);
    expect(dialog).toContain('adminFetch<RegistrationDetail>(`/registrations/${encodeURIComponent(id)}`)');
    expect(dialog).toMatch(/await load\(detail\.id\);\s+onChanged\?\.\(\);\s+notifyRegistrationsChanged\(\);/);
    expect(dialog).toContain('busy={isSaving}');
  });

  test('signed URLs are never stored in browser storage nor logged', () => {
    for (const source of [dialog, components('documentReview.ts')]) {
      expect(source).not.toMatch(/localStorage|sessionStorage|console\.(log|info|debug|warn|error)/);
    }
  });

  test('inspectors reach the read-only view from the Technical Inspection section', () => {
    const scrutineering = components('ScrutineeringTab.tsx');
    expect(scrutineering).toContain('canViewDocuments(role)');
    expect(scrutineering).toContain('<RegistrationDetailDialog registrationId={documentsFor} role={role}');
    expect(page).toMatch(/handleSubmitScrutineering=\{handleSubmitScrutineering\}\s+role=\{currentUser\?\.role\}/);
  });

  test('the new console files follow the contrast rule (no slate-500 text)', () => {
    for (const name of ['RegistrationDetailDialog.tsx', 'documentReview.ts', 'RegistrationsTab.tsx', 'ScrutineeringTab.tsx']) {
      expect(components(name)).not.toMatch(/text-slate-500|placeholder-slate-500/);
    }
  });
});

describe('Registration detail view (static render)', () => {
  test('shows the team summary, roster with ID proof, documents with status and feedback, and payment status', () => {
    const html = renderView();
    for (const text of [
      'Sky Strikers',
      'TEAM-SKY',
      'Class 40 (D40) Drone Soccer',
      'Example Institute of Technology',
      'Greater Noida',
      'Asha Captain',
      'asha@example.test',
      'GCDIS-2026-0042',
      'Document Review',
      'Ravi Pilot',
      'ravi@example.test',
      'Pilot',
      'Neha Mechanic',
      'No ID proof',
      'Institutional Approval Letter (NOC)',
      'noc.pdf',
      'insurance.png',
      'The policy number is not legible.',
      '1 awaiting review',
      'INR 21,000'
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toMatch(/>PENDING</);
    expect(html).toMatch(/>REJECTED</);
    expect(html).toMatch(/>VERIFIED</);
    expect(html).toMatch(/data-testid="payment-status"[^>]*>Success</);
    expect(html).toContain('>ID proof<');
    expect(html.match(/>View</g)).toHaveLength(3);
  });

  test('administrators see Approve and Reject for each document', () => {
    const html = renderView({ canDecide: true });
    expect(html.match(/>Approve</g)).toHaveLength(3);
    expect(html.match(/>Reject</g)).toHaveLength(3);
  });

  test('inspectors (canDecide false) can view files but get no decision controls', () => {
    expect(review.canDecideDocuments('INSPECTOR')).toBe(false);
    expect(review.canViewDocuments('INSPECTOR')).toBe(true);
    expect(review.canDecideDocuments('SUPER_ADMIN')).toBe(true);
    expect(review.canDecideDocuments('EVENT_ADMIN')).toBe(true);
    expect(review.canViewDocuments('JUDGE')).toBe(false);
    const html = renderView({ canDecide: false, decision: { docId: 'd1', status: 'REJECTED' } });
    expect(html).not.toMatch(/>Approve<|>Reject<|Confirm Rejection|<textarea/);
    expect(html).toContain('Approval and rejection are recorded by the Event Administrators.');
    expect(html.match(/>View</g)).toHaveLength(3);
  });

  test('the rejection form requires feedback of at most 1000 characters', () => {
    const empty = renderView({ decision: { docId: 'd1', status: 'REJECTED' }, feedback: '' });
    expect(empty).toContain('Reason for rejection (required, shown to the team)');
    expect(empty).toMatch(/<textarea[^>]*maxLength="1000"/);
    expect(empty).toMatch(/<textarea[^>]*required=""/);
    expect(empty).toMatch(/<button type="submit" disabled=""[^>]*>Confirm Rejection<\/button>/);
    const filled = renderView({ decision: { docId: 'd1', status: 'REJECTED' }, feedback: 'Unsigned letter.' });
    expect(filled).toMatch(/<button type="submit"(?! disabled)[^>]*>Confirm Rejection<\/button>/);
    const approve = renderView({ decision: { docId: 'd1', status: 'VERIFIED' } });
    expect(approve).toContain('Note to the team (optional)');
    expect(approve).toMatch(/<button type="submit"(?! disabled)[^>]*>Confirm Approval<\/button>/);
    expect(review.DOCUMENT_FEEDBACK_MAX).toBe(DOCUMENT_FEEDBACK_MAX_LENGTH);
  });

  test('the fallback link to an opened file opens in a new tab without opener or referrer', () => {
    const html = renderView({ opened: { id: 'doc:d1', url: `${API.replace('/api', '')}/api/uploads/files/k.pdf?token=t&expires=1`, image: false } });
    expect(html).toMatch(/<a href="[^"]+" target="_blank" rel="noopener noreferrer"/);
  });
});

describe('Viewing a file through a signed URL', () => {
  test('requests GET /uploads/signed-url/:assetId with the session cookie and returns the absolute address', async () => {
    const fetchMock = mockFetch({ url: '/api/uploads/files/abc.pdf?token=t0k&expires=99', expiresAt: '2026-10-15T10:05:00.000Z' });
    const log = jest.spyOn(console, 'log');
    const url = await review.fetchSignedFileUrl('22222222-2222-4222-8222-222222222222');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(`${API}/uploads/signed-url/22222222-2222-4222-8222-222222222222`);
    expect(init?.credentials).toBe('include');
    expect(init?.method).toBeUndefined();
    expect(url).toBe('http://localhost:4000/api/uploads/files/abc.pdf?token=t0k&expires=99');
    expect(log).not.toHaveBeenCalled();
  });

  test('a response without an address is reported as an error', async () => {
    mockFetch({});
    await expect(review.fetchSignedFileUrl('x')).rejects.toThrow('The server did not return an address for this file.');
  });

  test('openInNewTab clicks a temporary link with target _blank and rel noopener noreferrer', () => {
    const link: any = { click: jest.fn(), remove: jest.fn() };
    (global as any).document = { createElement: jest.fn(() => link), body: { appendChild: jest.fn() } };
    try {
      review.openInNewTab('http://localhost:4000/api/uploads/files/a.pdf?token=t&expires=1');
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
      expect(link.click).toHaveBeenCalled();
      expect(link.remove).toHaveBeenCalled();
    } finally {
      delete (global as any).document;
    }
  });

  test('the signed-URL endpoint stays limited to captains and SA / EA / INSPECTOR staff', () => {
    const roles = Reflect.getMetadata(AUDIENCE_ROLES_KEY, UploadsController.prototype.getSignedUrl);
    expect(roles).toEqual({ public: [UserRole.TEAM_CAPTAIN], admin: [UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.INSPECTOR] });
  });
});

describe('Approving and rejecting documents', () => {
  test('approve sends PATCH /registrations/:id/documents/:docId with JSON and the anti-CSRF header', async () => {
    const fetchMock = mockFetch({ id: 'd1', status: 'VERIFIED' });
    await review.submitDocumentDecision('reg-1', 'd1', 'VERIFIED', '  ');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/registrations/reg-1/documents/d1`);
    expect(init?.method).toBe('PATCH');
    expect(init?.credentials).toBe('include');
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(headers['Content-Type']).toBe('application/json');
    // An approval clears an earlier rejection note
    expect(JSON.parse(String(init?.body))).toEqual({ status: 'VERIFIED', feedback: '' });
  });

  test('reject sends the trimmed feedback', async () => {
    const fetchMock = mockFetch({ id: 'd1', status: 'REJECTED' });
    await review.submitDocumentDecision('reg-1', 'd1', 'REJECTED', '  The letter is not signed.  ');
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>)['X-Requested-With']).toBe('XMLHttpRequest');
    expect(JSON.parse(String(init?.body))).toEqual({ status: 'REJECTED', feedback: 'The letter is not signed.' });
  });

  test('reject without feedback, or with more than 1000 characters, is refused before any request', async () => {
    const fetchMock = mockFetch({});
    await expect(review.submitDocumentDecision('reg-1', 'd1', 'REJECTED', '   ')).rejects.toThrow(/give the reason for rejecting/);
    await expect(review.submitDocumentDecision('reg-1', 'd1', 'REJECTED', 'x'.repeat(1001))).rejects.toThrow(/must not exceed 1000/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(review.decisionError('VERIFIED', '')).toBeNull();
    expect(review.decisionError('REJECTED', 'x'.repeat(1000))).toBeNull();
  });

  test('the API still restricts decisions to SUPER_ADMIN and EVENT_ADMIN', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, RegistrationsController.prototype.verifyDocument);
    expect(roles).toEqual([UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN]);
    const guards = Reflect.getMetadata('__guards__', RegistrationsController.prototype.verifyDocument) as any[];
    expect(guards.map((g) => g?.name)).toEqual(expect.arrayContaining(['RolesGuard', 'CsrfGuard']));
  });
});

describe('API: asset ids on the staff detail view (GET /registrations/:id)', () => {
  const makeService = () => {
    const reg = {
      id: 'reg-1',
      team: {
        captainId: 'captain-1',
        members: [
          { id: 'm1', idProofUrl: '/api/uploads/files/id.png' },
          { id: 'm2', idProofUrl: null }
        ]
      },
      documents: [
        { id: 'd1', fileUrl: '/api/uploads/files/noc.pdf', status: 'PENDING' },
        { id: 'd2', fileUrl: 'https://legacy.example.test/doc.pdf', status: 'PENDING' }
      ],
      payments: []
    };
    const prisma = {
      registration: { findUnique: jest.fn(async () => JSON.parse(JSON.stringify(reg))) },
      mediaAsset: {
        findMany: jest.fn(async () => [
          { id: 'asset-noc', fileUrl: '/api/uploads/files/noc.pdf', mimeType: 'application/pdf' },
          { id: 'asset-id', fileUrl: '/api/uploads/files/id.png', mimeType: 'image/png' }
        ])
      }
    };
    return { service: new RegistrationsService(prisma as any, { logAction: jest.fn() } as any), prisma };
  };

  test.each([UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.INSPECTOR])('%s receives assetId / idProofAssetId', async (role) => {
    const { service, prisma } = makeService();
    const res: any = await service.findDetailById('reg-1', 'staff-1', role);
    expect(prisma.mediaAsset.findMany).toHaveBeenCalledWith({
      where: { fileUrl: { in: ['/api/uploads/files/noc.pdf', 'https://legacy.example.test/doc.pdf', '/api/uploads/files/id.png'] } },
      select: { id: true, fileUrl: true, mimeType: true }
    });
    expect(res.documents[0]).toMatchObject({ id: 'd1', assetId: 'asset-noc', mimeType: 'application/pdf' });
    expect(res.documents[1]).toMatchObject({ id: 'd2', assetId: null });
    expect(res.team.members[0]).toMatchObject({ id: 'm1', idProofAssetId: 'asset-id', idProofMimeType: 'image/png' });
    expect(res.team.members[1]).toMatchObject({ id: 'm2', idProofAssetId: null });
  });

  test('captains get their own registration unchanged (no extra fields, no asset lookup)', async () => {
    const { service, prisma } = makeService();
    const res: any = await service.findDetailById('reg-1', 'captain-1', UserRole.TEAM_CAPTAIN);
    expect(prisma.mediaAsset.findMany).not.toHaveBeenCalled();
    expect(res.documents[0]).not.toHaveProperty('assetId');
    expect(res.team.members[0]).not.toHaveProperty('idProofAssetId');
  });

  test("captains still cannot read another team's registration", async () => {
    const { service } = makeService();
    await expect(service.findDetailById('reg-1', 'captain-2', UserRole.TEAM_CAPTAIN)).rejects.toThrow(/not found/);
  });

  test('the controller serves the detail through findDetailById', () => {
    expect(read('apps', 'api', 'src', 'registrations', 'registrations.controller.ts')).toContain(
      'return this.registrationsService.findDetailById(id, req.user.id, req.user.role);'
    );
  });
});

describe('Portal: the captain sees each document status and the reviewer feedback', () => {
  test('a rejected document shows its status and the reason for rejection', () => {
    const html = renderToStaticMarkup(
      React.createElement(DocumentList, {
        documents: [
          { id: 'd1', type: 'INSURANCE', fileName: 'ins.pdf', status: 'REJECTED', feedback: 'The policy number is not legible.' },
          { id: 'd2', type: 'INSTITUTION_NOC', fileName: 'noc.pdf', status: 'VERIFIED', feedback: 'Thank you.' },
          { id: 'd3', type: 'OTHER', fileName: 'x.pdf', status: 'PENDING', feedback: null }
        ]
      })
    );
    expect(html).toContain('Reason for rejection: The policy number is not legible.');
    expect(html).toContain('Please upload a corrected document below.');
    expect(html).toContain('Reviewer&#x27;s note: Thank you.');
    expect(html).toContain('REJECTED');
    expect(html).toContain('VERIFIED');
    expect(html).toContain('PENDING REVIEW');
    expect(html.match(/data-testid="document-feedback"/g)).toHaveLength(2);
  });
});

describe('API: a rejection needs a reason', () => {
  const service = (doc: any) => {
    const prisma: any = {
      document: {
        findUnique: jest.fn().mockResolvedValue(doc),
        update: jest.fn().mockResolvedValue({ ...doc, status: 'X' })
      }
    };
    return { prisma, svc: new RegistrationsService(prisma, { logAction: jest.fn() } as any) };
  };
  const doc = { id: 'd1', registrationId: 'r1', status: 'PENDING' };

  test.each([undefined, '', '   '])('REJECTED with feedback %p is refused before any write', async (feedback) => {
    const { prisma, svc } = service(doc);
    await expect(svc.verifyDocument('r1', 'd1', 'REJECTED' as any, 'a1', 'EVENT_ADMIN', 'a@x', feedback as any)).rejects.toThrow(
      'Please give a reason when rejecting a document.'
    );
    expect(prisma.document.update).not.toHaveBeenCalled();
  });

  test('REJECTED with a reason, and VERIFIED with an empty note, are accepted', async () => {
    const a = service(doc);
    await a.svc.verifyDocument('r1', 'd1', 'REJECTED' as any, 'a1', 'EVENT_ADMIN', 'a@x', 'Scan is unreadable');
    expect(a.prisma.document.update).toHaveBeenCalled();
    const b = service(doc);
    await b.svc.verifyDocument('r1', 'd1', 'VERIFIED' as any, 'a1', 'EVENT_ADMIN', 'a@x', '');
    expect(b.prisma.document.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'VERIFIED', feedback: '' } }));
  });
});
