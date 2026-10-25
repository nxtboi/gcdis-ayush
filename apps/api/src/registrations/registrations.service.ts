import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  RegistrationStatus,
  DocumentType,
  DocumentStatus,
  canTransitionRegistration,
  isRoleAuthorizedForTransition,
  UserRole
} from '@gcdis/shared';
import { RegistrationQueryDto } from './dto/registration-query.dto';

type AuditEntry = Parameters<AuditService['logAction']>[0];

/** Staff roles that may open team documents and ID proofs (mirrors the signed-URL readers in UploadsController). */
const FILE_REVIEWER_ROLES: string[] = [UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.INSPECTOR];

@Injectable()
export class RegistrationsService {
  /** Set once the registration code sequence is known to exist, so DDL is not re-run per request. */
  private registrationSequenceReady = false;

  constructor(
    private prisma: PrismaService,
    private auditService: AuditService
  ) {}

  /**
   * Write an audit row through the given transaction client so that it commits or
   * rolls back atomically with the state change it describes.
   */
  private async logAuditInTx(tx: Prisma.TransactionClient, entry: AuditEntry) {
    const client = tx as any;
    if (typeof client?.auditLog?.create !== 'function') {
      // Client without an auditLog delegate (e.g. unit-test doubles): use the audit service
      return this.auditService.logAction(entry);
    }
    return new AuditService(client).logAction(entry);
  }

  /**
   * Next value of the registration code sequence. The sequence is created at most once per
   * process (ideally it already exists via migration); falls back to a count-based number.
   */
  private async nextRegistrationSequence(): Promise<number> {
    try {
      if (!this.registrationSequenceReady) {
        await this.prisma.$executeRawUnsafe(
          `CREATE SEQUENCE IF NOT EXISTS registration_code_seq START WITH 1 INCREMENT BY 1;`
        );
        this.registrationSequenceReady = true;
      }
      const seqRes: any = await this.prisma.$queryRawUnsafe(`SELECT nextval('registration_code_seq') as val;`);
      if (seqRes && seqRes[0] && seqRes[0].val) {
        return Number(seqRes[0].val);
      }
    } catch {
      // Sequence missing (e.g. dropped) or non-PostgreSQL backend: re-check on the next call
      this.registrationSequenceReady = false;
    }
    const count = await this.prisma.registration.count();
    return count + 1;
  }

  async findAll(query?: RegistrationQueryDto, userId?: string, userRole?: string) {
    const take = query?.limit ? Math.min(Number(query.limit), 100) : 50;
    const skip = query?.offset ? Number(query.offset) : 0;
    const where: any = {};

    // Ownership filter: Captains can ONLY see registrations for their own team
    if (userRole === UserRole.TEAM_CAPTAIN && userId) {
      where.team = { captainId: userId };
    }

    if (query?.status) where.status = query.status;
    if (query?.categoryId) where.categoryId = query.categoryId;

    const [total, registrations] = await Promise.all([
      this.prisma.registration.count({ where }),
      this.prisma.registration.findMany({
        where,
        take,
        skip,
        include: {
          team: {
            include: {
              captain: { select: { id: true, fullName: true, email: true, phone: true } },
              members: true
            }
          },
          category: true,
          documents: true,
          payments: true,
          inspections: true
        },
        orderBy: { submittedAt: 'desc' }
      })
    ]);

    return { total, registrations };
  }

  async findById(id: string, userId?: string, userRole?: string) {
    const reg = await this.prisma.registration.findUnique({
      where: { id },
      include: {
        team: {
          include: {
            captain: { select: { id: true, fullName: true, email: true, phone: true } },
            members: true
          }
        },
        category: true,
        documents: true,
        payments: true,
        inspections: true
      }
    });

    if (!reg) {
      throw new NotFoundException(`Registration with ID '${id}' not found`);
    }

    // Ownership check: Captain A cannot view Captain B's registration. Answer exactly like a missing id,
    // so a captain cannot learn whether another team's registration exists.
    if (userRole === UserRole.TEAM_CAPTAIN && userId && reg.team.captainId !== userId) {
      throw new NotFoundException(`Registration with ID '${id}' not found`);
    }

    return reg;
  }

  /**
   * GET /registrations/:id. For staff who review files (SUPER_ADMIN, EVENT_ADMIN, INSPECTOR) each document
   * and each member ID proof also carries the id of its stored upload (`assetId` / `idProofAssetId`) and its
   * MIME type, so the console can request a short-lived signed URL (GET /uploads/signed-url/:assetId).
   * Captains receive the unchanged registration (their own, enforced by findById).
   */
  async findDetailById(id: string, userId?: string, userRole?: string) {
    const reg = await this.findById(id, userId, userRole);
    if (!userRole || !FILE_REVIEWER_ROLES.includes(userRole)) return reg;

    const documents = Array.isArray(reg.documents) ? reg.documents : [];
    const members = Array.isArray(reg.team?.members) ? reg.team.members : [];
    const fileUrls = [
      ...documents.map((d) => d.fileUrl),
      ...members.map((m) => m.idProofUrl)
    ].filter((url): url is string => typeof url === 'string' && url.length > 0);
    if (fileUrls.length === 0) return reg;

    const assets = await this.prisma.mediaAsset.findMany({
      where: { fileUrl: { in: Array.from(new Set(fileUrls)) } },
      select: { id: true, fileUrl: true, mimeType: true }
    });
    const byUrl = new Map(assets.map((a) => [a.fileUrl, a]));

    return {
      ...reg,
      documents: documents.map((d) => ({
        ...d,
        assetId: byUrl.get(d.fileUrl)?.id ?? null,
        mimeType: byUrl.get(d.fileUrl)?.mimeType ?? null
      })),
      team: reg.team
        ? {
            ...reg.team,
            members: members.map((m) => ({
              ...m,
              idProofAssetId: m.idProofUrl ? byUrl.get(m.idProofUrl)?.id ?? null : null,
              idProofMimeType: m.idProofUrl ? byUrl.get(m.idProofUrl)?.mimeType ?? null : null
            }))
          }
        : reg.team
    };
  }

  async findByTeamId(teamId: string) {
    return this.prisma.registration.findMany({
      where: { teamId },
      include: {
        category: true,
        documents: true,
        payments: true,
        inspections: true
      },
      orderBy: { submittedAt: 'desc' },
      take: 100
    });
  }

  async createRegistration(
    teamId: string,
    categoryId: string,
    userId?: string,
    userRole?: string,
    userEmail?: string,
    ip?: string,
    userAgent?: string
  ) {
    // 1. Verify team exists
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: { captain: true }
    });
    if (!team) {
      throw new NotFoundException(`Team with ID '${teamId}' not found`);
    }

    // 2. Ownership check: Captain A cannot register Captain B's team
    if (userRole === UserRole.TEAM_CAPTAIN && userId && team.captainId !== userId) {
      throw new ForbiddenException('You may register your own team only.');
    }

    // 3. A team competes only in the category it was created for (no cross-category registrations)
    if (team.categoryId !== categoryId) {
      throw new BadRequestException("The registration category must match the team's own category.");
    }

    // 4. Verify category exists
    const category = await this.prisma.category.findUnique({
      where: { id: categoryId }
    });
    if (!category) {
      throw new NotFoundException(`Category with ID '${categoryId}' not found`);
    }
    // 4b. A category closed by the Secretariat accepts no new registrations
    if ((category as any).isActive === false) {
      throw new BadRequestException('The selected competition category is not open for registration.');
    }

    // 5. Ensure team is not already registered in this category
    const existing = await this.prisma.registration.findFirst({
      where: { teamId, categoryId }
    });
    if (existing) {
      throw new BadRequestException(`Your team is already registered for ${category.name}.`);
    }

    // 6. Generate sequential registration code using DB sequence
    const seqNumber = await this.nextRegistrationSequence();

    const codeSuffix = String(seqNumber).padStart(4, '0');
    const categoryPrefix = (category.slug || 'CAT').toUpperCase().replace(/\s+/g, '');
    const registrationCode = `GCDIS-2026-${categoryPrefix}-${codeSuffix}`;

    // Teams pay straight after submitting (the captain's email is already verified by EmailVerifiedGuard);
    // the Secretariat reviews the entry once it has been paid. A category without a fee stays SUBMITTED.
    const initialStatus = category.entryFee > 0 ? RegistrationStatus.PAYMENT_PENDING : RegistrationStatus.SUBMITTED;

    let registration;
    try {
      registration = await this.prisma.registration.create({
        data: {
          registrationCode,
          teamId,
          categoryId,
          status: initialStatus
        },
        include: {
          team: true,
          category: true,
          documents: true,
          payments: true
        }
      });
    } catch (err) {
      // Concurrent duplicate submission lost the race against the (teamId, categoryId) unique constraint
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = String((err.meta as any)?.target ?? '');
        if (target.includes('registrationCode') || target.includes('registration_code')) {
          throw new ConflictException('The registration could not be numbered at this moment. Please submit it again.');
        }
        throw new ConflictException(`Your team is already registered for ${category.name}.`);
      }
      throw err;
    }

    await this.auditService.logAction({
      actorId: userId || team.captainId,
      actorEmail: userEmail || team.captain?.email,
      actorRole: userRole || UserRole.TEAM_CAPTAIN,
      action: 'CREATE_REGISTRATION',
      entityType: 'Registration',
      entityId: registration.id,
      afterState: {
        registrationCode,
        teamName: team.name,
        categoryName: category.name,
        status: initialStatus
      },
      ipAddress: ip,
      userAgent
    });

    return registration;
  }

  async transitionStatus(
    id: string,
    targetStatus: RegistrationStatus,
    userRole: UserRole,
    userId?: string,
    userEmail?: string,
    reason?: string,
    ip?: string,
    userAgent?: string
  ) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Row locking: lock the registration row against concurrent updates
      try {
        await tx.$executeRaw`SELECT id FROM "registrations" WHERE id = ${id} FOR UPDATE`;
      } catch {
        // Fallback for mock environments without PostgreSQL row locking
      }

      const reg = await tx.registration.findUnique({
        where: { id },
        include: {
          team: true,
          category: true,
          documents: true,
          payments: true
        }
      });

      if (!reg) {
        throw new NotFoundException(`Registration with ID '${id}' not found`);
      }

      // 2. Ownership check: Captain A cannot transition Captain B's registration
      if (userRole === UserRole.TEAM_CAPTAIN && userId && reg.team.captainId !== userId) {
        throw new ForbiddenException('Forbidden: You can only update status for your own registration');
      }

      // 3. Validate state machine rule
      if (!canTransitionRegistration(reg.status as any, targetStatus as any)) {
        throw new BadRequestException(
          `Invalid status transition from '${reg.status}' to '${targetStatus}'`
        );
      }

      // 4. Validate RBAC rule for status transition
      if (!isRoleAuthorizedForTransition(userRole, targetStatus as any, reg.status as any)) {
        throw new ForbiddenException(
          `Role '${userRole}' is not authorized to transition registration to '${targetStatus}'`
        );
      }

      // 5. Document review is only for paid entries. Both ADMINISTRATIVE_REVIEW and REQUIRES_ACTION may move
      //    to DOCUMENT_REVIEW, and PAYMENT_PENDING may move to REQUIRES_ACTION, so the check covers every
      //    source status; otherwise PAYMENT_PENDING -> REQUIRES_ACTION -> DOCUMENT_REVIEW would skip payment.
      //    A free category (entry fee 0) has nothing to pay and is not blocked.
      const feeDue = !(reg.category && Number(reg.category.entryFee) === 0);
      if (
        targetStatus === RegistrationStatus.DOCUMENT_REVIEW &&
        feeDue &&
        !reg.payments.some((p) => p.status === 'SUCCESS')
      ) {
        throw new BadRequestException(
          reg.status === RegistrationStatus.ADMINISTRATIVE_REVIEW
            ? 'Cannot move to DOCUMENT_REVIEW: the entry fee has not been paid. Move the registration to PAYMENT_PENDING instead.'
            : 'Cannot move to DOCUMENT_REVIEW: the entry fee has not been paid. Move the registration to SUBMITTED, then through ADMINISTRATIVE_REVIEW to PAYMENT_PENDING, so the fee can be paid.'
        );
      }

      // 6. State Machine Constraint: Captains may only move to TECHNICAL_SUBMISSION when documents and payment are verified
      if (targetStatus === RegistrationStatus.TECHNICAL_SUBMISSION) {
        const isPaymentVerified = reg.payments.some((p) => p.status === 'SUCCESS');
        const isDocVerified =
          reg.documents.length > 0 &&
          reg.documents.every(
            (d) => d.status === DocumentStatus.VERIFIED || (d.status as any) === 'APPROVED'
          );

        if (!isPaymentVerified || !isDocVerified) {
          throw new BadRequestException(
            'Cannot move to TECHNICAL_SUBMISSION: Payment and all uploaded documents must be verified first'
          );
        }
      }

      const updated = await tx.registration.update({
        where: { id },
        data: {
          status: targetStatus as any,
          // approvedAt records the approval itself; later stages (e.g. COMPETING) must not overwrite it
          ...(targetStatus === RegistrationStatus.APPROVED
            ? { approvedAt: new Date() }
            : {})
        },
        include: {
          team: true,
          category: true,
          documents: true,
          payments: true
        }
      });

      await this.logAuditInTx(tx, {
        actorId: userId,
        actorEmail: userEmail,
        actorRole: userRole,
        action: 'REGISTRATION_STATUS_TRANSITION',
        entityType: 'Registration',
        entityId: id,
        beforeState: { status: reg.status },
        afterState: { status: targetStatus, reason },
        ipAddress: ip,
        userAgent
      });

      return updated;
    });
  }

  async addDocument(
    registrationId: string,
    type: DocumentType,
    assetId: string,
    userId?: string,
    userRole?: string,
    userEmail?: string,
    fileName?: string,
    ip?: string,
    userAgent?: string
  ) {
    const reg = await this.findById(registrationId, userId, userRole);

    // Ownership check on registration
    if (userRole === UserRole.TEAM_CAPTAIN && userId && reg.team.captainId !== userId) {
      throw new ForbiddenException('You may upload documents for your own registration only.');
    }

    // Document fileUrl must be an uploaded asset id owned by the caller, not a free URL
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { id: assetId }
    });

    if (!asset) {
      throw new NotFoundException('The uploaded file could not be found. Please upload it again.');
    }

    if (userRole === UserRole.TEAM_CAPTAIN && userId && asset.uploadedBy !== userId) {
      throw new ForbiddenException('You may submit only files that you have uploaded yourself.');
    }

    // Registration documents are private: a file uploaded as public site media must not be re-used as one.
    if ((asset as any).isPublic === true) {
      throw new BadRequestException('This file was uploaded as public media and cannot be submitted as a registration document.');
    }

    // The same upload linked twice (e.g. a repeated submission) would create a duplicate document for review.
    const alreadyLinked = await this.prisma.document.findFirst({
      where: { registrationId, fileUrl: asset.fileUrl },
      select: { id: true }
    });
    if (alreadyLinked) {
      throw new ConflictException('This file has already been submitted for your registration.');
    }

    const doc = await this.prisma.document.create({
      data: {
        registrationId,
        type,
        fileName: fileName || asset.fileName || `${type.toLowerCase()}_upload.pdf`,
        fileUrl: asset.fileUrl,
        status: DocumentStatus.PENDING
      }
    });

    await this.auditService.logAction({
      actorId: userId,
      actorEmail: userEmail,
      actorRole: userRole,
      action: 'UPLOAD_DOCUMENT',
      entityType: 'Document',
      entityId: doc.id,
      afterState: { registrationId, type, assetId, fileUrl: asset.fileUrl, status: 'PENDING' },
      ipAddress: ip,
      userAgent
    });

    return doc;
  }

  async verifyDocument(
    registrationId: string,
    docId: string,
    status: DocumentStatus,
    userId?: string,
    userRole?: string,
    userEmail?: string,
    feedback?: string,
    ip?: string,
    userAgent?: string
  ) {
    // A rejection must tell the team what to correct (the reason is shown in their portal). For other
    // decisions the note is optional; an empty note clears an earlier rejection reason.
    if (status === DocumentStatus.REJECTED && !(typeof feedback === 'string' && feedback.trim())) {
      throw new BadRequestException('Please give a reason when rejecting a document.');
    }

    const doc = await this.prisma.document.findUnique({ where: { id: docId } });
    if (!doc || doc.registrationId !== registrationId) {
      throw new NotFoundException(`Document '${docId}' not found for registration '${registrationId}'`);
    }

    const updated = await this.prisma.document.update({
      where: { id: docId },
      data: {
        status,
        feedback
      }
    });

    await this.auditService.logAction({
      actorId: userId,
      actorEmail: userEmail,
      actorRole: userRole,
      action: 'VERIFY_DOCUMENT',
      entityType: 'Document',
      entityId: docId,
      afterState: { registrationId, status, feedback },
      ipAddress: ip,
      userAgent
    });

    return updated;
  }
}
