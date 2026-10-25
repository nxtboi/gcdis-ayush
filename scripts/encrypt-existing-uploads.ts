/**
 * Encrypts existing PRIVATE uploads (ID proofs, team documents, unlinked private uploads) and cached
 * invoice PDFs in place with the GCE1 AES-256-GCM envelope used by the API (apps/api/src/uploads/file-encryption.ts).
 *
 * Usage (from the repository root):
 *
 *   npm run uploads:encrypt -- --dry-run          # report what would be encrypted; writes nothing
 *   npm run uploads:encrypt                       # encrypt in place
 *
 * Options:
 *   --dry-run                 Count and list only; no file is changed.
 *   --dir <path>              Upload directory (default: STORAGE_LOCAL_DIR resolved against apps/api, else apps/api/uploads).
 *   --invoice-cache-dir <p>   Cached invoice PDFs (default: apps/api/storage). Every file there is private.
 *   --skip-invoice-cache      Do not touch the invoice cache.
 *   --verbose                 Print every file name with its decision.
 *
 * Which uploads are private is decided exactly like UploadsService#isAssetPrivate: a file is private when a
 * registration Document or a TeamMember ID proof links to it, or when it has no public MediaAsset row.
 * The database is only READ (three SELECTs). Public site imagery is never encrypted.
 *
 * Safety:
 *   - Idempotent: files that already start with the "GCE1" header are skipped.
 *   - Atomic: each file is encrypted into a temporary file in the same directory, flushed to disk, verified
 *     by decrypting it again, and then renamed over the original. An interrupted run leaves either the old
 *     plaintext or the new ciphertext, never a partial file.
 *   - The key comes from FILE_ENCRYPTION_KEY (apps/api/.env or the environment) and is never printed. Outside
 *     production without FILE_ENCRYPTION_KEY the development key derived from JWT_SECRET is used (as the API
 *     does), so run this with the SAME configuration as the API that will serve the files.
 *   - Take a backup of the uploads volume (scripts/backup.sh) before the first real run.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  FILE_ENCRYPTION_MAGIC,
  decryptFileBuffer,
  encryptFileBuffer,
  resolveFileEncryptionKey
} from '../apps/api/src/uploads/file-encryption';

const UPLOAD_FILE_URL_PREFIX = '/api/uploads/files/';
const TEMP_MARKER = '.gce-tmp-';

export interface EncryptRunOptions {
  /** Directory whose regular files are considered. */
  dir: string;
  /** Decides whether a file (by its name) is private and must be encrypted. */
  isPrivate: (fileName: string) => boolean | Promise<boolean>;
  /** Required unless dryRun. */
  key?: Buffer;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface EncryptRunResult {
  scanned: number;
  alreadyEncrypted: number;
  publicSkipped: number;
  /** Private plaintext files found (dry run) or encrypted (real run). */
  privatePlaintext: number;
  encrypted: number;
  failed: number;
  files: string[];
}

async function startsWithMagic(filePath: string): Promise<boolean> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const probe = Buffer.alloc(FILE_ENCRYPTION_MAGIC.length);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    return bytesRead === probe.length && probe.equals(FILE_ENCRYPTION_MAGIC);
  } finally {
    await handle.close();
  }
}

/** Encrypts one file atomically (temp file + fsync + verify + rename). */
export async function encryptFileInPlace(filePath: string, key: Buffer): Promise<void> {
  const plaintext = await fs.promises.readFile(filePath);
  const sealed = encryptFileBuffer(plaintext, key);
  // Verify before replacing anything
  if (!decryptFileBuffer(sealed, key).equals(plaintext)) throw new Error('verification failed');
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}${TEMP_MARKER}${crypto.randomBytes(6).toString('hex')}`
  );
  const handle = await fs.promises.open(tmpPath, 'wx', 0o600);
  try {
    await handle.writeFile(sealed);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export async function encryptExistingUploads(opts: EncryptRunOptions): Promise<EncryptRunResult> {
  const log = opts.log || (() => undefined);
  if (!opts.dryRun && (!opts.key || opts.key.length !== 32)) {
    throw new Error('An encryption key is required unless --dry-run is given');
  }
  const result: EncryptRunResult = {
    scanned: 0,
    alreadyEncrypted: 0,
    publicSkipped: 0,
    privatePlaintext: 0,
    encrypted: 0,
    failed: 0,
    files: []
  };
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(opts.dir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      log(`  (directory does not exist: ${opts.dir})`);
      return result;
    }
    throw err;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    // Leftovers of an interrupted run and dotfiles (.gitkeep) are never touched
    if (entry.name.startsWith('.') || entry.name.includes(TEMP_MARKER)) continue;
    const filePath = path.join(opts.dir, entry.name);
    result.scanned++;
    try {
      if (await startsWithMagic(filePath)) {
        result.alreadyEncrypted++;
        log(`  skip (already encrypted) ${entry.name}`);
        continue;
      }
      if (!(await opts.isPrivate(entry.name))) {
        result.publicSkipped++;
        log(`  skip (public)            ${entry.name}`);
        continue;
      }
      result.privatePlaintext++;
      result.files.push(entry.name);
      if (opts.dryRun) {
        log(`  would encrypt            ${entry.name}`);
        continue;
      }
      await encryptFileInPlace(filePath, opts.key as Buffer);
      result.encrypted++;
      log(`  encrypted                ${entry.name}`);
    } catch (err: any) {
      result.failed++;
      log(`  FAILED                   ${entry.name}: ${err?.message || err}`);
    }
  }
  return result;
}

/** Same rule as UploadsService#isAssetPrivate, from three read-only queries. */
async function loadPrivacyClassifier(): Promise<{ isPrivate: (name: string) => boolean; close: () => Promise<void> }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const [publicAssets, documents, members] = await Promise.all([
    prisma.mediaAsset.findMany({ where: { isPublic: true }, select: { fileUrl: true } }),
    prisma.document.findMany({ select: { fileUrl: true } }),
    prisma.teamMember.findMany({ where: { idProofUrl: { not: null } }, select: { idProofUrl: true } })
  ]);
  const publicUrls = new Set<string>(publicAssets.map((a: any) => a.fileUrl));
  const linked = new Set<string>([
    ...documents.map((d: any) => d.fileUrl),
    ...members.map((m: any) => m.idProofUrl)
  ]);
  return {
    isPrivate: (name: string) => {
      const url = `${UPLOAD_FILE_URL_PREFIX}${name}`;
      return linked.has(url) || !publicUrls.has(url);
    },
    close: () => prisma.$disconnect()
  };
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..');
  const apiDir = path.join(repoRoot, 'apps', 'api');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(apiDir, '.env') });
  dotenv.config({ path: path.join(repoRoot, '.env') });

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const uploadDir = path.resolve(
    apiDir,
    argValue(args, '--dir') || process.env.STORAGE_LOCAL_DIR || 'uploads'
  );
  const invoiceDir = path.resolve(apiDir, argValue(args, '--invoice-cache-dir') || 'storage');
  const skipInvoices = args.includes('--skip-invoice-cache');

  let key: Buffer | undefined;
  try {
    const resolved = resolveFileEncryptionKey(process.env);
    key = resolved.key;
    if (resolved.source === 'DEV_JWT_SECRET') {
      console.warn('WARNING: FILE_ENCRYPTION_KEY is not set; using the development-only key derived from JWT_SECRET.');
    }
  } catch (err: any) {
    if (!dryRun) {
      console.error(`Cannot encrypt: ${err?.message || err}`);
      process.exit(1);
    }
    console.warn(`Note: no usable encryption key (${err?.message || err}); dry run continues.`);
  }

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Encrypting private uploads in ${uploadDir}`);
  const log = verbose ? (line: string) => console.log(line) : undefined;
  const classifier = await loadPrivacyClassifier();
  let uploads: EncryptRunResult;
  try {
    uploads = await encryptExistingUploads({ dir: uploadDir, isPrivate: classifier.isPrivate, key, dryRun, log });
  } finally {
    await classifier.close();
  }
  const summary = (label: string, r: EncryptRunResult) =>
    console.log(
      `${label}: scanned ${r.scanned}, already encrypted ${r.alreadyEncrypted}, public skipped ${r.publicSkipped}, ` +
        `private plaintext ${r.privatePlaintext}${dryRun ? ' (would be encrypted)' : `, encrypted ${r.encrypted}`}, failed ${r.failed}`
    );
  summary('Uploads', uploads);

  let failed = uploads.failed;
  if (!skipInvoices) {
    console.log(`${dryRun ? '[DRY RUN] ' : ''}Encrypting cached invoice PDFs in ${invoiceDir}`);
    const invoices = await encryptExistingUploads({ dir: invoiceDir, isPrivate: () => true, key, dryRun, log });
    summary('Invoice cache', invoices);
    failed += invoices.failed;
  }
  if (failed > 0) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
