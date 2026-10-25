import { AuditService } from '../apps/api/src/audit/audit.service';
import { UserRole } from '@gcdis/shared';

describe('Audit Logging & Immutability Verification (Execution Engine)', () => {
  let auditService: AuditService;
  let mockPrisma: any;
  let storedLogs: any[];

  beforeEach(() => {
    storedLogs = [];

    mockPrisma = {
      auditLog: {
        create: jest.fn(async ({ data }) => {
          const entry = {
            id: `audit-${storedLogs.length + 1}`,
            ...data,
            createdAt: new Date()
          };
          storedLogs.push(entry);
          return entry;
        }),
        count: jest.fn(async () => storedLogs.length),
        findMany: jest.fn(async ({ where, take, skip }) => {
          let list = [...storedLogs];
          if (where?.actorRole) list = list.filter((l) => l.actorRole === where.actorRole);
          if (where?.action?.contains) {
            list = list.filter((l) =>
              l.action.toLowerCase().includes(where.action.contains.toLowerCase())
            );
          }
          if (where?.OR) {
            list = list.filter((l) =>
              where.OR.some(
                (cond: any) =>
                  (cond.actorId && l.actorId === cond.actorId) ||
                  (cond.entityId && l.entityId === cond.entityId)
              )
            );
          }
          return list.slice(skip || 0, (skip || 0) + (take || 100));
        })
      }
    };

    auditService = new AuditService(mockPrisma as any);
  });

  test('1. logAction records complete immutable entry with actor, before/after state, and IP', async () => {
    const log = await auditService.logAction({
      actorId: 'usr-admin-1',
      actorEmail: 'director@gcdis.in',
      actorRole: UserRole.SUPER_ADMIN,
      action: 'SYSTEM_SETTINGS_UPDATE',
      entityType: 'SiteSetting',
      entityId: 'cfg-gst-rate',
      beforeState: { gstRate: 18 },
      afterState: { gstRate: 18 },
      ipAddress: '10.0.0.15',
      userAgent: 'Mozilla/5.0 GCDIS-Director-Console'
    });

    expect(log.id).toBeDefined();
    expect(log.actorEmail).toBe('director@gcdis.in');
    expect(log.action).toBe('SYSTEM_SETTINGS_UPDATE');
    expect(log.beforeState).toEqual({ gstRate: 18 });
    expect(log.afterState).toEqual({ gstRate: 18 });
    expect(log.ipAddress).toBe('10.0.0.15');
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  test('2. exportLogsCsv sanitizes formula injection attacks (=, +, -, @)', async () => {
    // Insert potentially malicious formula payload
    await auditService.logAction({
      actorEmail: '=cmd|"/C calc"!A0',
      actorRole: '+ADMIN_ESCALATION',
      action: '@HARMFUL_PAYLOAD',
      entityType: '-Formula_Test',
      entityId: '=1+1',
      ipAddress: '127.0.0.1'
    });

    const csvOutput = await auditService.exportLogsCsv();
    expect(csvOutput).toContain('Timestamp,Action,Actor Email,Actor Role,Entity Type,Entity ID,IP Address');

    // Formulas must be escaped with leading apostrophe
    expect(csvOutput).toContain("\"'@HARMFUL_PAYLOAD\"");
    expect(csvOutput).toContain("\"'=cmd|\"\"/C calc\"\"!A0\"");
    expect(csvOutput).toContain("\"'+ADMIN_ESCALATION\"");
    expect(csvOutput).toContain("\"'-Formula_Test\"");
  });

  test('3. findCaptainActivity securely scopes records to caller identity', async () => {
    await auditService.logAction({
      actorId: 'captain-a',
      action: 'REGISTRATION_SUBMITTED',
      entityType: 'Registration',
      entityId: 'reg-a'
    });
    await auditService.logAction({
      actorId: 'captain-b',
      action: 'REGISTRATION_SUBMITTED',
      entityType: 'Registration',
      entityId: 'reg-b'
    });

    const results = await auditService.findCaptainActivity('captain-a');
    expect(results.length).toBe(1);
    // The captain's own action: no actor identity is echoed back, only what happened
    expect(results[0]).toMatchObject({ entityId: 'reg-a', byStaff: false });
    expect(results[0]).not.toHaveProperty('actorId');
  });

  test('4. AuditService has NO update or delete mutation methods', () => {
    expect((auditService as any).update).toBeUndefined();
    expect((auditService as any).delete).toBeUndefined();
    expect((auditService as any).deleteMany).toBeUndefined();
    expect((auditService as any).updateMany).toBeUndefined();
  });
});
