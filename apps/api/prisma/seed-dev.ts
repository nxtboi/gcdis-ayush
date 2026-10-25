import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('[SECURITY ERROR] Dev seed script cannot be executed in production environment!');
    process.exit(1);
  }

  console.log('[GCDIS Dev Seeder] Running isolated development-only seed...');

  // Create a sample development captain for local developer testing
  const devCaptainEmail = 'dev.captain@example.local';
  const existingCaptain = await prisma.user.findUnique({ where: { email: devCaptainEmail } });

  if (!existingCaptain) {
    // Never hardcode credentials: the dev password must come from the environment and is never logged.
    const devPassword = process.env.DEV_SEED_CAPTAIN_PASSWORD;
    if (!devPassword || devPassword.length < 12) {
      console.error(
        '[GCDIS Dev Seeder] DEV_SEED_CAPTAIN_PASSWORD (min 12 chars) must be set to create the dev captain. Skipping.'
      );
      return;
    }
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(devPassword, salt);

    const captain = await prisma.user.create({
      data: {
        email: devCaptainEmail,
        passwordHash: hash,
        fullName: 'Dev Test Captain',
        role: Role.TEAM_CAPTAIN,
        organization: 'Local Dev University',
        phone: '+919999900000',
        isPasswordTemporary: false,
        mustChangePassword: false,
        isTwoFactorEnabled: false,
        // Dev fixture: treated as a confirmed address so registration and payment flows can be tested
        emailVerifiedAt: new Date()
      }
    });

    const categoryD20 = await prisma.category.findFirst({ where: { slug: 'd20' } });

    if (categoryD20) {
      await prisma.team.create({
        data: {
          categoryId: categoryD20.id,
          name: 'Dev Flight Squad',
          code: 'DEV-D20-001',
          captainId: captain.id,
          institutionName: 'Local Dev University',
          city: 'Bengaluru',
          country: 'India',
          isApprovedPublic: true
        }
      });
    }

    console.log(`[GCDIS Dev Seeder] Seeded development testing user: ${devCaptainEmail}`);
  } else {
    console.log('[GCDIS Dev Seeder] Dev captain already exists. Skipping.');
  }
}

main()
  .catch((e) => {
    console.error('[GCDIS Dev Seeder Error]', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
