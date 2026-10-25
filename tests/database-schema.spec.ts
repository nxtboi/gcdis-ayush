import * as fs from 'fs';
import * as path from 'path';

describe('Module 2: Database Schema & Baseline Seed Verification', () => {
  const rootDir = path.resolve(__dirname, '..');
  const schemaPath = path.join(rootDir, 'apps', 'api', 'prisma', 'schema.prisma');
  const seedPath = path.join(rootDir, 'apps', 'api', 'prisma', 'seed.ts');

  test('Prisma schema contains all required new operational models', () => {
    expect(fs.existsSync(schemaPath)).toBe(true);
    const schema = fs.readFileSync(schemaPath, 'utf-8');

    expect(schema).toContain('model SiteSetting');
    expect(schema).toContain('model ContentSection');
    expect(schema).toContain('model ContentVersion');
    expect(schema).toContain('model MediaAsset');
    expect(schema).toContain('model Prize');
    expect(schema).toContain('model Session');
    expect(schema).toContain('model TwoFactor');
    expect(schema).toContain('model LoginAttempt');
    expect(schema).toContain('model AuditLog');
  });

  test('User model has 2FA, session relations, and temporary password flags', () => {
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    expect(schema).toContain('isPasswordTemporary');
    expect(schema).toContain('mustChangePassword');
    expect(schema).toContain('isTwoFactorEnabled');
    expect(schema).toContain('sessions             Session[]');
    expect(schema).toContain('twoFactor            TwoFactor?');
  });

  test('AuditLog contains immutable audit trail fields and indices', () => {
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    expect(schema).toContain('beforeState Json?');
    expect(schema).toContain('afterState  Json?');
    expect(schema).toContain('actorEmail String?');
    expect(schema).toContain('userAgent  String?');
    expect(schema).toContain('@@index([createdAt])');
  });

  test('Seed contains authentic FIDA facts and canonical prize distribution', () => {
    expect(fs.existsSync(seedPath)).toBe(true);
    const seed = fs.readFileSync(seedPath, 'utf-8');

    // Canonical prize allocations
    expect(seed).toContain('31000'); // D40 1st
    expect(seed).toContain('21000'); // D40 2nd and D20 1st
    expect(seed).toContain('11000'); // D20 2nd
    expect(seed).toContain('16000'); // Unallocated remainder flagged Needs input
    expect(seed).toContain('100000'); // Total pool

    // FIDA Official Rules facts
    expect(seed).toContain('Federation of International Dronesoccer Association (FIDA)');
    expect(seed).toContain('40 cm ± 2 cm');
    expect(seed).toContain('20 cm ± 1 cm');
    expect(seed).toContain('110'); // maxWeightGrams for D20

    // No hardcoded personal names, emails, or fake passwords
    expect(seed).not.toContain('Password123!');
    expect(seed).not.toContain('er.tiwari03@gmail.com');
    expect(seed).not.toContain('devilsparsh2001outlook@gmail.com');
  });
});
