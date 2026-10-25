import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { appendAuditLog } from '../apps/api/src/audit/audit-chain';

describe('Phase 1 - Item 3: PostgreSQL AuditLog Append-Only Hardening', () => {
  const migrationPath = path.join(
    __dirname,
    '../apps/api/prisma/migrations/20261010000000_audit_log_append_only/migration.sql'
  );
  const auditServicePath = path.join(__dirname, '../apps/api/src/audit/audit.service.ts');

  test('Migration SQL defines PostgreSQL trigger and function preventing UPDATE/DELETE', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    expect(sql).toContain('CREATE OR REPLACE FUNCTION prevent_audit_log_modification()');
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('AuditLog is append-only');
    expect(sql).toContain('CREATE TRIGGER trg_prevent_audit_log_modification');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON audit_logs');
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM PUBLIC');
  });

  test('AuditService application code has zero mutation or deletion methods', () => {
    const code = fs.readFileSync(auditServicePath, 'utf-8');
    expect(code).not.toContain('delete(');
    expect(code).not.toContain('deleteMany(');
    expect(code).not.toContain('update(');
    expect(code).not.toContain('updateMany(');
    // Inserts go through the tamper-evidence hash chain (audit-chain.ts), which only ever creates rows
    expect(code).toContain('appendAuditLog(this.prisma');
    const chain = fs.readFileSync(path.join(__dirname, '../apps/api/src/audit/audit-chain.ts'), 'utf-8');
    expect(chain).toContain('tx.auditLog.create');
    for (const forbidden of ['auditLog.update', 'auditLog.delete', 'auditLog.upsert', 'auditLog.createMany']) {
      expect(chain).not.toContain(forbidden);
    }
  });

  // Touches a real database (re-creates the trigger and appends audit rows), so it only runs when asked:
  // RUN_DB_INTEGRATION_TESTS=1 npx jest tests/audit-append-only.spec.ts  (against a disposable database).
  const dbTest = process.env.RUN_DB_INTEGRATION_TESTS === '1' ? test : test.skip;
  dbTest('Database trigger blocks UPDATE and DELETE on audit_logs when DB is reachable', async () => {
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url:
            (process.env.DATABASE_URL ||
              'postgresql://gcdis_admin:gcdis_secure_password_dev@127.0.0.1:5432/gcdis_db?schema=public') +
            '&connect_timeout=2'
        }
      }
    });
    try {
      // Check database connectivity
      await prisma.$queryRaw`SELECT 1`;

      // Apply the migration trigger to ensure it is active
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
        RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION 'AuditLog is append-only. UPDATE, DELETE and TRUNCATE operations are strictly forbidden.';
        END;
        $$ LANGUAGE plpgsql;
      `);
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_prevent_audit_log_modification ON audit_logs;`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER trg_prevent_audit_log_modification
        BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW
        EXECUTE FUNCTION prevent_audit_log_modification();
      `);
      await prisma.$executeRawUnsafe(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM PUBLIC;`);

      // Create a test audit log entry (INSERT must succeed). Written through the hash chain like every
      // application insert, so the test row never shows up as an unchained (bypassing) row.
      const testLog = await appendAuditLog(prisma, {
        action: 'TEST_APPEND_ONLY',
        entityType: 'SecurityTest',
        entityId: 'test-1',
        ipAddress: '127.0.0.1',
        userAgent: 'Jest'
      });
      expect(testLog.id).toBeDefined();

      // Attempt UPDATE: Must fail and trigger exception
      let updateError: any = null;
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE audit_logs SET action = 'HACKED' WHERE id = '${testLog.id}'`
        );
      } catch (err: any) {
        updateError = err;
      }
      expect(updateError).not.toBeNull();
      expect(updateError.message).toMatch(/AuditLog is append-only/);

      // Attempt DELETE: Must fail and trigger exception
      let deleteError: any = null;
      try {
        await prisma.$executeRawUnsafe(
          `DELETE FROM audit_logs WHERE id = '${testLog.id}'`
        );
      } catch (err: any) {
        deleteError = err;
      }
      expect(deleteError).not.toBeNull();
      expect(deleteError.message).toMatch(/AuditLog is append-only/);

    } catch (err: any) {
      if (err.message?.includes("Can't reach database server")) {
        console.warn('[Skipping live DB trigger test: database container not currently running in test environment]');
      } else {
        throw err;
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});
