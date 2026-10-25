import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { emailNotVerifiedException } from './account-recovery.service';

/**
 * Team captains must have confirmed their email address before submitting a registration or creating a
 * payment order: 403 { statusCode: 403, code: 'EMAIL_NOT_VERIFIED', message }. Other roles pass.
 * Use after AuthGuard('jwt').
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req?.user;
    if (!user || user.role !== 'TEAM_CAPTAIN') return true;

    let verified: boolean | undefined = typeof user.emailVerified === 'boolean' ? user.emailVerified : undefined;
    if (verified === undefined) {
      const row = await this.prisma.user.findUnique({ where: { id: user.id }, select: { emailVerifiedAt: true } });
      verified = Boolean(row?.emailVerifiedAt);
    }
    if (!verified) throw emailNotVerifiedException();
    return true;
  }
}
