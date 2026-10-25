/**
 * Tamper-evidence hash chain for the audit log (audit_logs).
 *
 * Every new row carries its position in the chain (chainSeq, 1, 2, 3, ...), the previous row's hash (prevHash; 64
 * zeros for the first row) and rowHash = sha256(prevHash + canonical row JSON). Changing, deleting or inserting a row
 * anywhere in the chain breaks a link that verifyAuditChain() reports. The database triggers already refuse UPDATE,
 * DELETE and TRUNCATE; the chain makes a change made around them (superuser, restored dump, disabled trigger) visible.
 *
 * Appends are serialised in two layers: an in-process queue (so one API instance holds at most one database
 * connection waiting for the chain) and a transaction-level Postgres advisory lock (so several API instances never
 * fork the chain). The unique index on chainSeq is the last line of defence; a conflict is retried.
 *
 * Framework-free on purpose: AuditService, the auth services and prisma/bootstrap-admin.ts share it.
 */
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

/** prevHash of the first row of the chain. */
export const AUDIT_CHAIN_GENESIS = '0'.repeat(64);
/** Arbitrary constant key of the advisory lock that serialises chain appends ("GCDIS" + 1). */
export const AUDIT_CHAIN_LOCK_KEY = 4_743_249_001;
const VERIFY_BATCH = 1000;
const APPEND_ATTEMPTS = 5;

export interface AuditEntryInput {
  actorId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** The fields covered by rowHash, exactly as stored. */
export interface ChainedRowFields {
  id: string;
  chainSeq: number;
  prevHash: string;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeState: unknown;
  afterState: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date | string;
}

/** Deterministic JSON: object keys sorted at every level, Dates as ISO strings, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  return JSON.stringify(value);
}

/**
 * JSON column values as they come back from Postgres (jsonb): plain JSON data, no undefined, no Dates, no
 * class instances. Stored and hashed in this form so that a re-read row hashes identically. undefined/null -> null.
 */
export function normaliseJsonValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value));
}

function toIso(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString();
}

/** Canonical JSON of the hashed fields of a row. */
export function canonicalAuditRow(row: ChainedRowFields): string {
  return canonicalJson({
    id: row.id,
    chainSeq: Number(row.chainSeq),
    prevHash: row.prevHash,
    actorId: row.actorId ?? null,
    actorEmail: row.actorEmail ?? null,
    actorRole: row.actorRole ?? null,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId ?? null,
    beforeState: row.beforeState ?? null,
    afterState: row.afterState ?? null,
    ipAddress: row.ipAddress ?? null,
    userAgent: row.userAgent ?? null,
    createdAt: toIso(row.createdAt)
  });
}

/** rowHash = sha256(prevHash + canonical row JSON), hex. */
export function computeAuditRowHash(row: ChainedRowFields): string {
  return crypto.createHash('sha256').update(row.prevHash + canonicalAuditRow(row), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------------------------------
// Append

/** In-process queue: one chain append at a time per API instance. */
let appendQueue: Promise<unknown> = Promise.resolve();

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const run = appendQueue.then(work, work);
  appendQueue = run.catch(() => undefined);
  return run;
}

function isUniqueViolation(err: any): boolean {
  return err?.code === 'P2002';
}

/**
 * Appends one audit row to the chain and returns the stored row. Throws when the row cannot be written
 * (callers that must never fail on auditing already catch).
 */
export function appendAuditLog(prisma: any, entry: AuditEntryInput): Promise<any> {
  return serialise(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
      try {
        return await appendOnce(prisma, entry);
      } catch (err) {
        lastError = err;
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw lastError;
  });
}

async function appendOnce(prisma: any, entry: AuditEntryInput): Promise<any> {
  const work = async (tx: any) => {
    // Serialises appends across API instances until this transaction ends
    if (typeof tx.$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`);
    }
    // (Minimal test doubles without findFirst start a new chain)
    const head =
      typeof tx.auditLog.findFirst === 'function'
        ? await tx.auditLog.findFirst({
            where: { chainSeq: { not: null } },
            orderBy: { chainSeq: 'desc' },
            select: { chainSeq: true, rowHash: true }
          })
        : null;
    const chainSeq = head?.chainSeq ? Number(head.chainSeq) + 1 : 1;
    const prevHash = head?.rowHash || AUDIT_CHAIN_GENESIS;
    const fields: ChainedRowFields = {
      id: crypto.randomUUID(),
      chainSeq,
      prevHash,
      actorId: entry.actorId ?? null,
      actorEmail: entry.actorEmail ?? null,
      actorRole: entry.actorRole ?? null,
      action: String(entry.action),
      entityType: String(entry.entityType),
      entityId: entry.entityId ?? null,
      beforeState: normaliseJsonValue(entry.beforeState),
      afterState: normaliseJsonValue(entry.afterState),
      ipAddress: entry.ipAddress || '127.0.0.1',
      userAgent: entry.userAgent || 'Unknown',
      // Millisecond precision, as stored (TIMESTAMP(3))
      createdAt: new Date(Math.floor(Date.now()))
    };
    const rowHash = computeAuditRowHash(fields);
    return tx.auditLog.create({
      data: {
        ...fields,
        // A JSON null is stored as SQL NULL (undefined), which reads back as null
        beforeState: fields.beforeState === null ? undefined : fields.beforeState,
        afterState: fields.afterState === null ? undefined : fields.afterState,
        rowHash
      }
    });
  };
  // A real Prisma client serialises with the advisory lock inside an interactive transaction. Test doubles
  // (no database) run the same steps directly; the unique chainSeq index and the retry keep them correct.
  if (prisma instanceof PrismaClient && typeof prisma.$transaction === 'function') {
    return prisma.$transaction(work, { maxWait: 10_000, timeout: 15_000 });
  }
  return work(prisma);
}

// ---------------------------------------------------------------------------------------------------------------
// Verify

export type AuditChainBreakReason =
  | 'HASH_MISMATCH'
  | 'PREVIOUS_HASH_MISMATCH'
  | 'SEQUENCE_GAP'
  | 'UNCHAINED_ROW';

export interface AuditChainBreak {
  /** Row at which the chain no longer verifies (null when the row itself is missing, e.g. a deleted first row). */
  id: string | null;
  chainSeq: number | null;
  createdAt: string | null;
  action: string | null;
  reason: AuditChainBreakReason;
  message: string;
}

export interface AuditChainReport {
  ok: boolean;
  /** Chained rows checked. */
  checkedRows: number;
  /** Rows written before the chain existed (not covered). */
  legacyRows: number;
  /** Last chain position and hash (anchor these externally to also detect removal of the newest rows). */
  headSeq: number | null;
  headHash: string | null;
  firstBreak: AuditChainBreak | null;
  verifiedAt: string;
}

function breakAt(row: any | null, reason: AuditChainBreakReason, message: string): AuditChainBreak {
  return {
    id: row?.id ?? null,
    chainSeq: row?.chainSeq ?? null,
    createdAt: row?.createdAt ? toIso(row.createdAt) : null,
    action: row?.action ?? null,
    reason,
    message
  };
}

/**
 * Walks the chain in order and reports the first broken link: a row whose content no longer matches its
 * rowHash, a row whose prevHash is not the previous row's hash, a missing position (deleted row), or a row
 * without a chain position written after the chain started (inserted around the application).
 */
export async function verifyAuditChain(prisma: any): Promise<AuditChainReport> {
  const verifiedAt = new Date().toISOString();
  let checkedRows = 0;
  let expectedSeq = 1;
  let prevHash = AUDIT_CHAIN_GENESIS;
  let firstBreak: AuditChainBreak | null = null;
  let genesisAt: Date | null = null;
  let headSeq: number | null = null;
  let headHash: string | null = null;
  let cursor = 0;

  outer: for (;;) {
    const rows: any[] = await prisma.auditLog.findMany({
      where: { chainSeq: { gt: cursor } },
      orderBy: { chainSeq: 'asc' },
      take: VERIFY_BATCH
    });
    if (!rows || rows.length === 0) break;
    for (const row of rows) {
      const seq = Number(row.chainSeq);
      if (genesisAt === null) genesisAt = new Date(row.createdAt);
      if (seq !== expectedSeq) {
        firstBreak = breakAt(
          row,
          'SEQUENCE_GAP',
          expectedSeq === 1
            ? `The chain does not start at position 1 (first position found: ${seq}); the earliest rows are missing.`
            : `Chain positions ${expectedSeq} to ${seq - 1} are missing; rows were removed before this one.`
        );
        break outer;
      }
      if (row.prevHash !== prevHash) {
        firstBreak = breakAt(row, 'PREVIOUS_HASH_MISMATCH', 'The row does not link to the hash of the previous row.');
        break outer;
      }
      const expected = computeAuditRowHash({ ...row, chainSeq: seq });
      if (row.rowHash !== expected) {
        firstBreak = breakAt(row, 'HASH_MISMATCH', 'The row content no longer matches its stored hash; it was modified.');
        break outer;
      }
      checkedRows++;
      prevHash = row.rowHash;
      headSeq = seq;
      headHash = row.rowHash;
      expectedSeq = seq + 1;
      cursor = seq;
    }
    if (rows.length < VERIFY_BATCH) break;
  }

  let legacyRows = 0;
  if (genesisAt) {
    // Rows without a chain position written after the chain started bypassed the chain
    const unchained = await prisma.auditLog.findFirst({
      where: { chainSeq: null, createdAt: { gte: genesisAt } },
      orderBy: { createdAt: 'asc' }
    });
    if (unchained && !firstBreak) {
      firstBreak = breakAt(unchained, 'UNCHAINED_ROW', 'A row without a chain position was written after the chain started.');
    }
    legacyRows = Number(await prisma.auditLog.count({ where: { chainSeq: null, createdAt: { lt: genesisAt } } })) || 0;
  } else {
    legacyRows = Number(await prisma.auditLog.count({ where: { chainSeq: null } })) || 0;
  }

  return { ok: firstBreak === null, checkedRows, legacyRows, headSeq, headHash, firstBreak, verifiedAt };
}
