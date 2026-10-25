import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { appendAuditLog, verifyAuditChain, type AuditChainReport } from './audit-chain';
import { SecurityAlertService } from '../security/security-alert.service';

/** Hard ceiling for any single audit query (CSV export uses the full ceiling). */
export const AUDIT_MAX_ROWS = 5000;

export interface AuditLogQueryFilters {
  actorId?: string;
  actorRole?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * What a captain may see of an audit row in their own activity feed. Their own actions keep their details;
 * actions taken by staff on their account show only what happened and when, never the staff member's
 * identity, IP address, browser or internal notes.
 */
export function captainActivityView(row: any, userId: string) {
  const base = { id: row.id, action: row.action, entityType: row.entityType, entityId: row.entityId, createdAt: row.createdAt };
  if (row.actorId === userId) {
    return { ...base, actorRole: row.actorRole, beforeState: row.beforeState, afterState: row.afterState, byStaff: false };
  }
  return { ...base, byStaff: true };
}

@Injectable()
export class AuditService {
  constructor(
    private prisma: PrismaService,
    @Optional() private securityAlerts?: SecurityAlertService
  ) {}

  /**
   * Immutable logging: records write actions to PostgreSQL audit_logs.
   * Append-only event store; every row is linked into the tamper-evidence hash chain (audit-chain.ts).
   */
  async logAction(data: {
    actorId?: string;
    actorEmail?: string;
    actorRole?: string;
    action: string;
    entityType: string;
    entityId?: string;
    beforeState?: any;
    afterState?: any;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return appendAuditLog(this.prisma, {
      actorId: data.actorId,
      actorEmail: data.actorEmail,
      actorRole: data.actorRole,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId,
      beforeState: data.beforeState,
      afterState: data.afterState,
      ipAddress: data.ipAddress,
      userAgent: data.userAgent
    });
  }

  /**
   * Verifies the audit hash chain (GET /audit/verify-chain, Super Administrator). The check itself is audited;
   * a broken chain raises the AUDIT_CHAIN_BROKEN security alert.
   */
  async verifyChain(actor?: { id?: string; email?: string; role?: string }, ipAddress?: string, userAgent?: string): Promise<AuditChainReport> {
    const report = await verifyAuditChain(this.prisma);
    if (!report.ok && report.firstBreak && this.securityAlerts) {
      void this.securityAlerts
        .alert('AUDIT_CHAIN_BROKEN', `audit-chain|${report.firstBreak.chainSeq ?? report.firstBreak.id ?? 'unknown'}`, {
          reason: report.firstBreak.reason,
          rowId: report.firstBreak.id,
          chainSeq: report.firstBreak.chainSeq,
          checkedBy: actor?.email || actor?.id
        })
        .catch(() => undefined);
    }
    try {
      await this.logAction({
        actorId: actor?.id,
        actorEmail: actor?.email,
        actorRole: actor?.role,
        action: 'AUDIT_CHAIN_VERIFIED',
        entityType: 'AuditLog',
        afterState: {
          ok: report.ok,
          checkedRows: report.checkedRows,
          legacyRows: report.legacyRows,
          headSeq: report.headSeq,
          firstBreak: report.firstBreak ? { id: report.firstBreak.id, chainSeq: report.firstBreak.chainSeq, reason: report.firstBreak.reason } : null
        },
        ipAddress,
        userAgent
      });
    } catch {
      // The report is still returned when the audit entry cannot be written
    }
    return report;
  }

  async findAllLogs(filters?: AuditLogQueryFilters) {
    const where: any = {};

    if (filters?.actorId) where.actorId = filters.actorId;
    if (filters?.actorRole) where.actorRole = filters.actorRole;
    if (filters?.action) where.action = { contains: filters.action, mode: 'insensitive' };
    if (filters?.entityType) where.entityType = filters.entityType;
    if (filters?.entityId) where.entityId = filters.entityId;

    if (filters?.startDate || filters?.endDate) {
      where.createdAt = {};
      if (filters.startDate) where.createdAt.gte = this.parseDate(filters.startDate, 'startDate');
      if (filters.endDate) where.createdAt.lte = this.parseDate(filters.endDate, 'endDate');
    }

    if (filters?.search) {
      where.OR = [
        { action: { contains: filters.search, mode: 'insensitive' } },
        { entityType: { contains: filters.search, mode: 'insensitive' } },
        { actorEmail: { contains: filters.search, mode: 'insensitive' } }
      ];
    }

    const [total, logs] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(Math.floor(Number(filters?.limit) || 100), 1), AUDIT_MAX_ROWS),
        skip: Math.max(Math.floor(Number(filters?.offset) || 0), 0)
      })
    ]);

    return { total, logs };
  }

  private parseDate(value: string, field: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} must be a valid date`);
    }
    return date;
  }

  /**
   * Activity log for Captains: view actions related to their team/user
   */
  async findCaptainActivity(userId: string) {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { actorId: userId },
          { entityId: userId }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    return rows.map((row: any) => captainActivityView(row, userId));
  }

  /**
   * Export audit log records to CSV format with formula injection protection
   */
  async exportLogsCsv(filters?: AuditLogQueryFilters): Promise<string> {
    const { logs } = await this.findAllLogs({ ...filters, limit: AUDIT_MAX_ROWS, offset: 0 });
    const headers = ['Timestamp', 'Action', 'Actor Email', 'Actor Role', 'Entity Type', 'Entity ID', 'IP Address'];

    const escapeCsvCell = (value: any): string => {
      if (value === null || value === undefined) return '""';
      let str = String(value);
      // CSV formula injection protection: escape values starting with =, +, -, @, \t, \r
      if (/^[=+\-@\t\r]/.test(str)) {
        str = `'${str}`;
      }
      return `"${str.replace(/"/g, '""')}"`;
    };

    const rows = logs.map((l) => [
      escapeCsvCell(l.createdAt.toISOString()),
      escapeCsvCell(l.action),
      escapeCsvCell(l.actorEmail || ''),
      escapeCsvCell(l.actorRole || ''),
      escapeCsvCell(l.entityType),
      escapeCsvCell(l.entityId || ''),
      escapeCsvCell(l.ipAddress || '')
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }

  /**
   * Security Alerts: Detect suspicious activity patterns
   */
  async getSecurityAlerts() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const failedLogins = await this.prisma.loginAttempt.groupBy({
      by: ['email'],
      where: {
        successful: false,
        attemptedAt: { gte: oneHourAgo }
      },
      _count: { email: true },
      having: {
        email: { _count: { gte: 3 } }
      }
    });

    const recentRoleChanges = await this.prisma.auditLog.findMany({
      where: {
        action: 'CHANGE_USER_ROLE',
        createdAt: { gte: oneHourAgo }
      },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    return {
      failedLoginAlerts: failedLogins.map((f) => ({ email: f.email, count: f._count.email })),
      roleChangeAlerts: recentRoleChanges
    };
  }
}
