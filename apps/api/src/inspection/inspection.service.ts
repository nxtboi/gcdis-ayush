import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RegistrationsService } from '../registrations/registrations.service';
import {
  InspectionStatus,
  TechnicalInspectionInput,
  RegistrationStatus,
  UserRole,
  isRoleAuthorizedForTransition
} from '@gcdis/shared';

/**
 * Check keys that carry each recorded measurement. The staff console sends the first key of each
 * list; the remaining keys are accepted from earlier clients.
 */
export const MEASUREMENT_CHECK_KEYS = {
  diameterMm: ['diameterMm', 'sphereDiameterMm'],
  weightGrams: ['weightGrams', 'allUpWeightGrams'],
  failsafeLatencySec: ['killSwitchLatencySeconds', 'failsafeKillSwitch']
} as const;

/** Numeric measurement for a column, taken from the first matching check key; 0 when not supplied. */
export function measurementOf(
  checks: Record<string, { value?: unknown } | undefined>,
  field: keyof typeof MEASUREMENT_CHECK_KEYS
): number {
  for (const key of MEASUREMENT_CHECK_KEYS[field]) {
    const check = checks[key];
    const value = Number(check?.value);
    if (check && check.value !== null && check.value !== '' && Number.isFinite(value)) return value;
  }
  return 0;
}

@Injectable()
export class InspectionService {
  constructor(
    private prisma: PrismaService,
    private registrationsService: RegistrationsService
  ) {}

  async findByRegistrationId(registrationId: string, userId?: string, userRole?: string) {
    const reg = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      include: { team: true }
    });
    if (!reg) {
      throw new NotFoundException(`Registration '${registrationId}' not found`);
    }

    if (userId && userRole) {
      const isOwner = reg.team.captainId === userId;
      const isAdminOrInspector = [UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.INSPECTOR].includes(userRole as any);
      if (!isOwner && !isAdminOrInspector) {
        throw new ForbiddenException('Forbidden: You can only view inspections for your own registration');
      }
    }

    return this.prisma.technicalInspection.findMany({
      where: { registrationId },
      orderBy: { inspectedAt: 'desc' },
      take: 100
    });
  }

  async findAllInspections(query?: { limit?: number; offset?: number }) {
    const limit = Math.floor(Number(query?.limit));
    const offset = Math.floor(Number(query?.offset));
    const take = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 50;
    const skip = Number.isFinite(offset) && offset > 0 ? offset : 0;

    return this.prisma.technicalInspection.findMany({
      take,
      skip,
      include: {
        registration: {
          include: {
            team: true,
            category: true
          }
        }
      },
      orderBy: { inspectedAt: 'desc' }
    });
  }

  /**
   * Records a technical inspection and moves the registration to ELIGIBILITY_REVIEW (passed) or
   * REQUIRES_ACTION (failed). Only registrations at TECHNICAL_INSPECTION can be inspected. Status and
   * role are checked before anything is written, so a rejected request never leaves an orphaned record.
   */
  async recordInspection(
    inspectorId: string,
    inspectorName: string,
    input: TechnicalInspectionInput,
    inspectorRole: UserRole = UserRole.INSPECTOR,
    inspectorEmail?: string
  ) {
    const reg = await this.registrationsService.findById(input.registrationId);

    if (reg.status !== RegistrationStatus.TECHNICAL_INSPECTION) {
      throw new BadRequestException(
        `Registration ${reg.registrationCode || reg.id} is not awaiting technical inspection (current status: ${reg.status}). ` +
          'Move it to TECHNICAL_INSPECTION before recording an inspection.'
      );
    }

    const entries = Object.entries(input.checks ?? {});
    if (entries.length === 0) {
      throw new BadRequestException('At least one inspection check is required.');
    }

    let allPassed = true;
    const verifiedChecks: Record<string, { passed: boolean; value?: any; note?: string }> = {};

    for (const [key, checkItem] of entries) {
      const isPassed = !!checkItem?.passed;
      verifiedChecks[key] = {
        passed: isPassed,
        value: checkItem?.value,
        note: checkItem?.note
      };
      if (!isPassed) {
        allPassed = false;
      }
    }

    const status = allPassed ? InspectionStatus.PASSED : InspectionStatus.FAILED;
    const targetStatus = allPassed ? RegistrationStatus.ELIGIBILITY_REVIEW : RegistrationStatus.REQUIRES_ACTION;

    if (!isRoleAuthorizedForTransition(inspectorRole, targetStatus, reg.status as RegistrationStatus)) {
      throw new ForbiddenException(`Role ${inspectorRole} is not authorised to record inspection outcomes.`);
    }

    const inspection = await this.prisma.technicalInspection.create({
      data: {
        registrationId: input.registrationId,
        inspectorId,
        weightGrams: measurementOf(verifiedChecks, 'weightGrams'),
        diameterMm: measurementOf(verifiedChecks, 'diameterMm'),
        failsafeLatencySec: measurementOf(verifiedChecks, 'failsafeLatencySec'),
        checks: verifiedChecks,
        status,
        notes: input.notes ? `[${inspectorName}] ${input.notes}` : `Inspected by ${inspectorName}`
      }
    });

    await this.registrationsService.transitionStatus(
      reg.id,
      targetStatus,
      inspectorRole,
      inspectorId,
      inspectorEmail,
      allPassed ? 'Technical inspection passed' : 'Technical inspection failed'
    );

    return inspection;
  }
}
