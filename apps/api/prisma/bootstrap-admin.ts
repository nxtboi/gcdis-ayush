import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { evaluatePasswordPolicy } from '../src/auth/password-policy';
import { appendAuditLog } from '../src/audit/audit-chain';

// Load environment variables from .env if present
dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const prisma = new PrismaClient();

async function bootstrapAdmin() {
  console.log('[GCDIS Admin Bootstrap] Initializing Super Admin provisioning...');

  const adminEmail = process.env.SUPER_ADMIN_EMAIL;
  const tempPassword = process.env.SUPER_ADMIN_TEMP_PASSWORD;

  if (!adminEmail || !tempPassword) {
    console.error('================================================================');
    console.error('[ERROR] SUPER_ADMIN_EMAIL and SUPER_ADMIN_TEMP_PASSWORD must be');
    console.error('provided in environment variables to bootstrap Super Admin.');
    console.error('Example:');
    console.error('  SUPER_ADMIN_EMAIL="admin@gcdis.in"');
    console.error('  SUPER_ADMIN_TEMP_PASSWORD="<strong temporary password, min 12 chars>"');
    console.error('================================================================');
    process.exit(1);
  }

  // Same password policy as the API: 12-128 characters, three of four character classes, not
  // containing the email local part, not in the Have I Been Pwned corpus (HIBP_CHECK=false disables).
  const policy = await evaluatePasswordPolicy(tempPassword, adminEmail);
  if (policy.ok === false) {
    console.error('================================================================');
    console.error('[SECURITY ERROR] SUPER_ADMIN_TEMP_PASSWORD does not meet the password policy.');
    console.error(` ${policy.message}`);
    console.error('================================================================');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({
    where: { email: adminEmail.toLowerCase().trim() }
  });

  if (existing) {
    console.log(`[GCDIS Admin Bootstrap] Super Admin '${adminEmail}' already exists in database.`);
    console.log('[GCDIS Admin Bootstrap] Idempotent exit: Existing administrator credentials preserved.');
    return;
  }

  const salt = await bcrypt.genSalt(12);
  const passwordHash = await bcrypt.hash(tempPassword, salt);

  const admin = await prisma.user.create({
    data: {
      email: adminEmail.toLowerCase().trim(),
      passwordHash,
      fullName: 'Super Administrator',
      role: Role.SUPER_ADMIN,
      organization: 'GCDIS Secretariat Directorate',
      isPasswordTemporary: true,
      mustChangePassword: true,
      isTwoFactorEnabled: false,
      // Provisioned by the operator: the address is treated as verified
      emailVerifiedAt: new Date()
    }
  });

  // Record audit trail of bootstrap initialization
  // Linked into the audit hash chain like every other audit row
  await appendAuditLog(prisma, {
    actorId: admin.id,
    actorEmail: admin.email,
    actorRole: 'SUPER_ADMIN',
    action: 'BOOTSTRAP_SUPER_ADMIN',
    entityType: 'User',
    entityId: admin.id,
    afterState: {
      email: admin.email,
      role: admin.role,
      mustChangePassword: true,
      isTwoFactorEnabled: false
    },
    ipAddress: '127.0.0.1',
    userAgent: 'CLI/BootstrapScript'
  });

  console.log('================================================================');
  console.log(`[SUCCESS] Super Admin created: ${admin.email}`);
  console.log('Security Enforcement:');
  console.log(' - Temporary password flagged: Forced reset required upon first login.');
  console.log(' - Staff 2FA gate active: Mandatory TOTP enrolment required upon first login.');
  console.log('================================================================');
}

bootstrapAdmin()
  .catch((e) => {
    console.error('[GCDIS Admin Bootstrap Error]', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
