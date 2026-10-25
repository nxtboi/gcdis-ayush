import { Injectable, NotFoundException, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import * as QRCode from 'qrcode';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PdfGeneratorService } from './pdf-generator.service';
import { UserRole } from '@gcdis/shared';
import { getPassSigningSecret } from '../auth/jwt-secrets';

@Injectable()
export class CertificatesService {
  constructor(
    private prisma: PrismaService,
    private pdfGeneratorService: PdfGeneratorService
  ) {}

  async generateMemberPassPdf(memberId: string, userId: string, userRole: string): Promise<Buffer> {
    const member = await this.prisma.teamMember.findUnique({
      where: { id: memberId },
      include: {
        team: {
          include: {
            category: true,
            registrations: {
              orderBy: { submittedAt: 'desc' },
              take: 1
            }
          }
        }
      }
    });

    if (!member) {
      throw new NotFoundException(`Team member '${memberId}' not found in database`);
    }

    const isAdminOrInspector = [UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.INSPECTOR].includes(userRole as any);
    const isTeamCaptain = member.team.captainId === userId;
    const isSelf = member.userId === userId;

    if (!isAdminOrInspector && !isTeamCaptain && !isSelf) {
      throw new ForbiddenException('Forbidden: You can only download passes for your own team members');
    }

    const latestReg = member.team.registrations[0];
    const regStatus = latestReg ? latestReg.status : 'PENDING';
    // No hardcoded fallback: a publicly known key would let anyone forge pass QR signatures.
    // Production requires a dedicated PASS_SIGNING_SECRET (never JWT_SECRET); dev derives one.
    let secret: string;
    try {
      secret = getPassSigningSecret();
    } catch {
      throw new InternalServerErrorException('Pass signing secret is not configured');
    }

    const qrPayload = JSON.stringify({
      id: member.id,
      code: member.team.code,
      name: member.fullName,
      role: member.memberRole,
      status: regStatus
    });
    const signature = crypto.createHmac('sha256', secret).update(qrPayload).digest('hex');
    const qrVerificationUrl = `${process.env.PUBLIC_SITE_URL || 'https://gcdis.in'}/verify/pass?p=${encodeURIComponent(qrPayload)}&s=${signature}`;

    // cacheId: the pass is cached encrypted at rest under a hash of these fields (see passCacheFileName),
    // so a change to the member, the registration status or the team data renders a fresh pass.
    return this.pdfGeneratorService.generateAccreditationPassPdf({
      cacheId: member.id,
      teamName: member.team.name,
      teamId: member.team.code,
      institution: member.team.institutionName,
      memberName: member.fullName,
      memberRole: member.memberRole,
      category: member.team.category?.name || 'Class 20 (D20) Drone Soccer',
      status: regStatus === 'ACCREDITED' || regStatus === 'APPROVED' ? 'VERIFIED PASSPORT' : regStatus,
      qrUrl: qrVerificationUrl
    });
  }

  async generatePassPdf(data: {
    teamName: string;
    teamId: string;
    institution: string;
    memberName: string;
    memberRole: string;
    category?: string;
    status?: string;
  }): Promise<Buffer> {
    return this.pdfGeneratorService.generateAccreditationPassPdf({
      teamName: data.teamName,
      teamId: data.teamId,
      institution: data.institution,
      memberName: data.memberName,
      memberRole: data.memberRole,
      category: data.category || 'Class 20 (D20) Drone Soccer',
      status: data.status || 'VERIFIED PASSPORT'
    });
  }

  /**
   * Public verification without leaking sensitive PII
   */
  async verifyCode(code: string) {
    const cert = await this.prisma.certificate.findUnique({
      where: { code: code.toUpperCase() }
    });

    if (!cert) {
      return { isValid: false, message: 'Certificate code not found in official registry' };
    }

    const qrDataUrl = await QRCode.toDataURL(cert.qrVerificationUrl);

    // Strictly return only public verification data (No personal emails, phones, or IDs)
    return {
      isValid: true,
      certificate: {
        code: cert.code,
        recipientName: cert.recipientName,
        teamName: cert.teamName,
        achievementTitle: cert.achievementTitle,
        issuedDate: cert.issuedDate
      },
      qrDataUrl
    };
  }

  /**
   * Issue certificate with crypto-secure unique verification code
   */
  async generateCertificate(data: {
    registrationId: string;
    recipientName: string;
    teamName: string;
    achievementTitle: string;
  }) {
    const year = new Date().getFullYear();
    // Cryptographically secure 8-character hex code
    const secureToken = crypto.randomBytes(4).toString('hex').toUpperCase();
    const code = `GCDIS-CERT-${year}-${secureToken}`;

    const baseUrl = process.env.PUBLIC_SITE_URL || 'http://localhost:3000';
    const qrVerificationUrl = `${baseUrl}/verify/${code}`;

    return this.prisma.certificate.create({
      data: {
        code,
        registrationId: data.registrationId,
        recipientName: data.recipientName,
        teamName: data.teamName,
        achievementTitle: data.achievementTitle,
        issuedDate: new Date(),
        pdfUrl: `${baseUrl}/api/certificates/${code}/pdf`,
        qrVerificationUrl
      }
    });
  }

  async findAll(query?: { limit?: number; offset?: number }) {
    const take = query?.limit ? Math.min(Number(query.limit), 100) : 50;
    const skip = query?.offset ? Number(query.offset) : 0;

    return this.prisma.certificate.findMany({
      orderBy: { issuedDate: 'desc' },
      take,
      skip
    });
  }
}
