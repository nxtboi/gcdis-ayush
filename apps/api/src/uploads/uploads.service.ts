import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
  Optional
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  validateUploadedBuffer,
  ValidatedFileResult,
  stripImageMetadata,
  readImageDimensions,
  VIDEO_MIME_TYPES
} from '../common/utils/upload-validator.util';
import { UserRole } from '@gcdis/shared';
import { ClamAvService, fileRejectedException } from '../security/clamav.service';
import { SecurityAlertService } from '../security/security-alert.service';
import {
  FILE_ENCRYPTION_MAGIC,
  FileDecryptionError,
  decryptFileBuffer,
  encryptFileBuffer,
  fileEncryptionConfigErrors,
  isEncryptedFile,
  resolveFileEncryptionKey
} from './file-encryption';

/** Public URL prefix under which stored uploads are served (see UploadsController#getFile). */
export const UPLOAD_FILE_URL_PREFIX = '/api/uploads/files/';

/**
 * Every accepted upload purpose. Anything else is refused with 400 (the JSON endpoint validates it in
 * UploadFileDto, the multipart endpoint in processUpload). TEAM_LOGO was removed: no client used it and
 * it let captains publish arbitrary public files.
 */
export const UPLOAD_PURPOSES = [
  'DOCUMENT',
  'ID_PROOF',
  'CMS_BACKGROUND',
  'CMS_MEDIA',
  'SPONSOR_LOGO',
  'GALLERY_IMAGE',
  'SITE_IMAGE',
  'EVENT_VIDEO'
] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];
const UPLOAD_PURPOSE_SET: ReadonlySet<string> = new Set(UPLOAD_PURPOSES);

export function isUploadPurpose(value: unknown): value is UploadPurpose {
  return typeof value === 'string' && UPLOAD_PURPOSE_SET.has(value);
}

/**
 * Upload purposes whose files are intended for the public site (served with public caching).
 * Every other purpose (DOCUMENT, ID_PROOF) is private: readable only through a signed URL,
 * which is issued only to the uploader or staff (see generateSignedUrl). Every public purpose is
 * administrator-only.
 */
export const PUBLIC_UPLOAD_PURPOSES = new Set([
  'CMS_BACKGROUND',
  'CMS_MEDIA',
  'SPONSOR_LOGO',
  'GALLERY_IMAGE',
  'SITE_IMAGE',
  'EVENT_VIDEO'
]);
/** Public purposes that only administrators may use. */
export const ADMIN_ONLY_PURPOSES = new Set(['CMS_BACKGROUND', 'CMS_MEDIA', 'SPONSOR_LOGO', 'GALLERY_IMAGE', 'SITE_IMAGE', 'EVENT_VIDEO']);

/**
 * EVENT_VIDEO: the championship page hero video. Administrator-only and public (stored in plaintext and
 * served with public caching and HTTP Range support, like site images). MP4 or WebM only, verified by magic
 * bytes; never re-encoded. Photos for the championship page use the existing SITE_IMAGE (poster) and
 * GALLERY_IMAGE (gallery) purposes, which are re-encoded with sharp.
 */
export const VIDEO_UPLOAD_PURPOSE = 'EVENT_VIDEO';
export { VIDEO_MIME_TYPES };

/** Default size limit of an EVENT_VIDEO upload: 60 MB. */
export const DEFAULT_VIDEO_UPLOAD_MAX_MB = 60;
/** Default multipart limit of /uploads/stream for every other purpose: 25 MB. */
export const STREAM_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Size limit of an EVENT_VIDEO upload in bytes; UPLOAD_VIDEO_MAX_MB overrides the 60 MB default (1..500).
 * The nginx /api/uploads/stream location (client_max_body_size 64M) and clamd's StreamMaxLength must allow it.
 */
export function videoUploadMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env.UPLOAD_VIDEO_MAX_MB);
  const value = Number.isFinite(mb) && mb > 0 ? Math.min(mb, 500) : DEFAULT_VIDEO_UPLOAD_MAX_MB;
  return Math.round(value * 1024 * 1024);
}

/** Raster image types accepted for site imagery (never SVG, never PDF). */
export const SITE_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Image-only purposes for the public site and their size limits. */
export const IMAGE_PURPOSE_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  SPONSOR_LOGO: 2 * 1024 * 1024,
  GALLERY_IMAGE: 8 * 1024 * 1024,
  SITE_IMAGE: 8 * 1024 * 1024
});

/** Default total storage per captain account (sum of MediaAsset.sizeBytes): 100 MB. */
export const DEFAULT_CAPTAIN_UPLOAD_QUOTA_BYTES = 100 * 1024 * 1024;

/** Per-captain storage quota; UPLOAD_CAPTAIN_QUOTA_MB overrides the 100 MB default. */
export function captainUploadQuotaBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env.UPLOAD_CAPTAIN_QUOTA_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : DEFAULT_CAPTAIN_UPLOAD_QUOTA_BYTES;
}

/** Private captain purposes whose unlinked uploads are removed after UNLINKED_UPLOAD_MAX_AGE_MS. */
export const CLEANUP_PURPOSES = ['DOCUMENT', 'ID_PROOF'];
/** Unlinked private uploads older than this are deleted (file and MediaAsset row). */
export const UNLINKED_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The cleanup runs opportunistically on upload, at most once per interval per API instance. */
export const UNLINKED_UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const UNLINKED_UPLOAD_CLEANUP_BATCH = 100;

export function fileUrlForStorageKey(storageKey: string): string {
  return `${UPLOAD_FILE_URL_PREFIX}${path.basename(storageKey)}`;
}

function getSigningSecret(): string {
  const secret = process.env.UPLOAD_SIGNING_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    // Fail closed: never sign/verify download URLs with a hardcoded fallback key
    throw new Error('UPLOAD_SIGNING_SECRET or JWT_SECRET must be configured to sign upload URLs');
  }
  return secret;
}

@Injectable()
export class UploadsService implements OnModuleInit {
  private readonly uploadDir: string;
  private readonly logger = new Logger(UploadsService.name);
  private readonly clamAv: ClamAvService;
  private lastCleanupAt = 0;
  private cleanupRunning = false;
  private devKeyWarned = false;

  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    @Optional() clamAv?: ClamAvService,
    @Optional() private securityAlerts?: SecurityAlertService
  ) {
    // Unit tests construct the service directly; the scanner then reads CLAMAV_* from the environment too
    this.clamAv = clamAv ?? new ClamAvService();
    this.uploadDir = process.env.STORAGE_LOCAL_DIR || path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  /**
   * Startup check for at-rest encryption of private uploads. Production refuses to start without a strong,
   * non-placeholder FILE_ENCRYPTION_KEY (64 hex characters); a malformed key fails in every environment.
   * Development without the key uses a key derived from JWT_SECRET and logs a warning.
   */
  onModuleInit(): void {
    const errors = fileEncryptionConfigErrors(process.env);
    if (errors.length) {
      throw new Error(`Upload encryption configuration error: ${errors.join(' ')}`);
    }
    try {
      this.fileKey();
    } catch (err: any) {
      // Development without FILE_ENCRYPTION_KEY and JWT_SECRET: private uploads fail until one is set
      this.logger.warn(`Private upload encryption is unavailable: ${err?.message || err}`);
    }
  }

  /** AES-256 key for private files (HKDF-derived); warns once when the development fallback is in use. */
  private fileKey(): Buffer {
    const resolved = resolveFileEncryptionKey(process.env);
    if (resolved.source === 'DEV_JWT_SECRET' && !this.devKeyWarned) {
      this.devKeyWarned = true;
      this.logger.warn(
        'FILE_ENCRYPTION_KEY is not set: private uploads are encrypted with a development-only key derived from JWT_SECRET. ' +
          'Set FILE_ENCRYPTION_KEY (64 hex characters) before storing real data; production refuses to start without it.'
      );
    }
    return resolved.key;
  }

  async processUpload(
    buffer: Buffer,
    originalFilename: string,
    uploaderId?: string,
    uploaderRole?: string,
    purpose: string = 'DOCUMENT',
    /** Request context for the FILE_UPLOAD audit row (actor email, client IP and user agent). */
    auditContext: { actorEmail?: string; ipAddress?: string; userAgent?: string } = {}
  ) {
    // 0. Strict purpose whitelist (the multipart endpoint passes the form field through unvalidated)
    if (!isUploadPurpose(purpose)) {
      throw new BadRequestException(`purpose must be one of: ${UPLOAD_PURPOSES.join(', ')}`);
    }

    // 1. Role-based purpose authorization: only administrators may upload CMS backgrounds / public site media
    const isAdmin = uploaderRole === UserRole.SUPER_ADMIN || uploaderRole === UserRole.EVENT_ADMIN;
    if (ADMIN_ONLY_PURPOSES.has(purpose) && !isAdmin) {
      throw new ForbiddenException(
        purpose === 'CMS_BACKGROUND'
          ? 'Forbidden: Only administrators can upload CMS backgrounds'
          : 'Forbidden: Only administrators can upload public site media'
      );
    }
    const isPublic = PUBLIC_UPLOAD_PURPOSES.has(purpose);

    // 2. Validate size, built-in signatures (EICAR) and magic bytes
    const imageLimit = IMAGE_PURPOSE_LIMITS[purpose];
    const isVideoPurpose = purpose === VIDEO_UPLOAD_PURPOSE;
    const maxSizeBytes = imageLimit
      ? imageLimit
      : isVideoPurpose
      ? videoUploadMaxBytes()
      : purpose === 'CMS_BACKGROUND'
      ? 25 * 1024 * 1024
      : purpose === 'ID_PROOF'
      ? 5 * 1024 * 1024
      : 10 * 1024 * 1024;

    const validated: ValidatedFileResult = validateUploadedBuffer(buffer, originalFilename, {
      maxSizeBytes,
      // Sponsor logos, gallery and site images: JPEG / PNG / WebP only (magic-byte checked)
      ...(imageLimit ? { allowedMimeTypes: SITE_IMAGE_MIME_TYPES } : {}),
      // Championship hero video: MP4 / WebM only (magic-byte checked); video is accepted for no other purpose
      ...(isVideoPurpose ? { allowedMimeTypes: VIDEO_MIME_TYPES } : {})
    });

    // 3. Malware scan (clamd INSTREAM) of the bytes as received, before anything is stored or linked.
    //    Disabled without CLAMAV_HOST; scanner unavailable -> 503 when CLAMAV_REQUIRED, else accepted with a warning.
    const scan = await this.clamAv.scan(validated.buffer);
    if (scan.status === 'infected') {
      await this.recordMalwareBlocked(validated, scan.signature, purpose, uploaderId, uploaderRole);
      throw fileRejectedException();
    }

    // 4. Re-encode images with sharp to strip metadata (EXIF/ICC/XMP)
    let finalBuffer = validated.buffer;
    if (validated.mimeType.startsWith('image/')) {
      finalBuffer = await stripImageMetadata(validated.buffer, validated.mimeType);
    }

    // 4b. Pixel dimensions (header parse; null when unknown)
    const dimensions = validated.mimeType.startsWith('image/')
      ? readImageDimensions(finalBuffer, validated.mimeType)
      : null;

    // 4c. Per-captain storage quota (sum of the account's stored uploads), checked before anything is written
    if (uploaderRole === UserRole.TEAM_CAPTAIN && uploaderId) {
      await this.assertWithinQuota(uploaderId, finalBuffer.length);
    }

    // 5. Generate secure, random storage key (UUID + random bytes), never user-supplied names
    // Videos take the extension of their verified type, never the client's file name
    const ext = validated.mimeType.startsWith('video/')
      ? `.${validated.mimeType.split('/')[1]}`
      : path.extname(validated.fileName) || `.${validated.mimeType.split('/')[1]}`;
    const secureStorageKey = `${crypto.randomUUID()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
    const destinationPath = path.join(this.uploadDir, secureStorageKey);

    // 6. Write file to persistent storage volume without blocking the event loop.
    //    'wx' guarantees we never overwrite an existing object. Private files (ID proofs, team documents)
    //    are encrypted at rest (AES-256-GCM "GCE1" envelope) after the malware scan and re-encode, so the
    //    scanner always sees plaintext. Public site imagery stays plaintext (served publicly and cached).
    const storedBytes = isPublic ? finalBuffer : encryptFileBuffer(finalBuffer, this.fileKey());
    await fs.promises.writeFile(destinationPath, storedBytes, { flag: 'wx' });

    // 7. Construct the serving URL (access is still governed by isAssetPrivate)
    const fileUrl = fileUrlForStorageKey(secureStorageKey);

    // 8. Record media asset in PostgreSQL
    const asset = await this.prisma.mediaAsset.create({
      data: {
        fileName: validated.fileName,
        fileUrl,
        mimeType: validated.mimeType,
        sizeBytes: finalBuffer.length,
        altText: validated.fileName,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        // Ownership + visibility are recorded at upload time so an unlinked private upload
        // (e.g. an ID proof not yet attached to a TeamMember) is never served publicly.
        uploadedBy: uploaderId,
        purpose,
        isPublic
      }
    });

    // 9. Audit log upload event
    await this.auditService.logAction({
      actorId: uploaderId,
      actorEmail: auditContext.actorEmail,
      actorRole: uploaderRole,
      action: 'FILE_UPLOAD',
      entityType: 'MediaAsset',
      entityId: asset.id,
      afterState: {
        fileName: validated.fileName,
        mimeType: validated.mimeType,
        sizeBytes: finalBuffer.length,
        sha256: validated.sha256,
        purpose
      },
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent
    });

    // 10. Opportunistic cleanup of abandoned private uploads (there is no scheduler); it runs in the
    //     background and never delays or fails this upload.
    this.scheduleUnlinkedCleanup();

    return {
      assetId: asset.id,
      fileName: validated.fileName,
      fileUrl,
      mimeType: validated.mimeType,
      sizeBytes: finalBuffer.length,
      checksumSha256: validated.sha256,
      isPublic,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null
    };
  }

  /** 413 when the captain's stored uploads plus this file would exceed the per-account quota. */
  private async assertWithinQuota(uploaderId: string, incomingBytes: number): Promise<void> {
    const quota = captainUploadQuotaBytes();
    if (incomingBytes > quota) {
      throw new HttpException(
        { statusCode: HttpStatus.PAYLOAD_TOO_LARGE, error: 'Payload Too Large', code: 'UPLOAD_QUOTA_EXCEEDED', message: 'This file is larger than the storage allowance for your account.' },
        HttpStatus.PAYLOAD_TOO_LARGE
      );
    }
    const delegate: any = this.prisma.mediaAsset;
    // PrismaService always provides aggregate; minimal unit-test doubles may not
    if (typeof delegate?.aggregate !== 'function') return;
    const agg: any = await delegate.aggregate({
      where: { uploadedBy: uploaderId },
      _sum: { sizeBytes: true }
    });
    const used = Number(agg?._sum?.sizeBytes ?? 0);
    if (used + incomingBytes > quota) {
      const mb = (n: number) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
          error: 'Payload Too Large',
          code: 'UPLOAD_QUOTA_EXCEEDED',
          message: `This upload would exceed the storage allowance of ${mb(quota)} for your account (${mb(used)} already used). Please contact the GCDIS Secretariat if you need more space.`
        },
        HttpStatus.PAYLOAD_TOO_LARGE
      );
    }
  }

  private scheduleUnlinkedCleanup(now: number = Date.now()): void {
    if (this.cleanupRunning || now - this.lastCleanupAt < UNLINKED_UPLOAD_CLEANUP_INTERVAL_MS) return;
    if (typeof (this.prisma.mediaAsset as any)?.findMany !== 'function') return;
    this.lastCleanupAt = now;
    this.cleanupRunning = true;
    void this.cleanupUnlinkedUploads(new Date(now))
      .catch((err: any) => this.logger.warn(`Unlinked upload cleanup failed: ${err?.message || err}`))
      .finally(() => {
        this.cleanupRunning = false;
      });
  }

  /**
   * Deletes private captain uploads (DOCUMENT / ID_PROOF, isPublic=false) older than 24 hours that
   * nothing references: no registration Document, TeamMember ID proof, team or sponsor logo, gallery
   * image, event banner or category rules PDF uses the URL. Returns the number of uploads removed.
   */
  async cleanupUnlinkedUploads(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - UNLINKED_UPLOAD_MAX_AGE_MS);
    const candidates = await this.prisma.mediaAsset.findMany({
      where: { isPublic: false, purpose: { in: CLEANUP_PURPOSES }, createdAt: { lt: cutoff } },
      select: { id: true, fileUrl: true },
      orderBy: { createdAt: 'asc' },
      take: UNLINKED_UPLOAD_CLEANUP_BATCH
    });
    let removed = 0;
    for (const asset of candidates || []) {
      if (typeof asset.fileUrl !== 'string' || !asset.fileUrl.startsWith(UPLOAD_FILE_URL_PREFIX)) continue;
      if (await this.isFileReferenced(asset.fileUrl)) continue;
      try {
        await this.deleteStoredFile(asset.fileUrl);
        removed++;
      } catch (err: any) {
        this.logger.warn(`Could not remove unlinked upload ${asset.id}: ${err?.message || err}`);
      }
    }
    if (removed > 0) {
      this.logger.log(`Removed ${removed} unlinked private upload(s) older than 24 hours`);
      try {
        await this.auditService.logAction({
          action: 'UNLINKED_UPLOADS_REMOVED',
          entityType: 'MediaAsset',
          afterState: { removed, olderThan: cutoff.toISOString() }
        });
      } catch {
        // Non-fatal
      }
    }
    return removed;
  }

  /**
   * True when any record links to the stored file. Fails safe: a lookup error, or a reference table
   * missing from the client, counts as referenced so nothing is deleted.
   */
  private async isFileReferenced(fileUrl: string): Promise<boolean> {
    const p: any = this.prisma;
    const checks: Array<[string, Record<string, string>]> = [
      ['document', { fileUrl }],
      ['teamMember', { idProofUrl: fileUrl }],
      ['team', { logoUrl: fileUrl }],
      ['sponsor', { logoUrl: fileUrl }],
      ['galleryImage', { imageUrl: fileUrl }],
      ['event', { bannerUrl: fileUrl }],
      ['category', { rulesPdfUrl: fileUrl }]
    ];
    try {
      const results = await Promise.all(
        checks.map(([model, where]) => {
          const delegate = p?.[model];
          if (typeof delegate?.findFirst !== 'function') return Promise.resolve(true);
          return delegate.findFirst({ where, select: { id: true } });
        })
      );
      return results.some(Boolean);
    } catch {
      return true;
    }
  }

  private async recordMalwareBlocked(
    validated: ValidatedFileResult,
    signature: string,
    purpose: string,
    uploaderId?: string,
    uploaderRole?: string
  ): Promise<void> {
    const details = {
      fileName: validated.fileName,
      mimeType: validated.mimeType,
      sizeBytes: validated.buffer.length,
      sha256: validated.sha256,
      signature,
      purpose
    };
    this.logger.warn(`Upload blocked by the malware scan: ${signature} (sha256 ${validated.sha256})`);
    try {
      await this.auditService.logAction({
        actorId: uploaderId,
        actorRole: uploaderRole,
        action: 'UPLOAD_MALWARE_BLOCKED',
        entityType: 'MediaAsset',
        afterState: details
      });
    } catch {
      // Non-fatal: the upload is refused regardless
    }
    if (this.securityAlerts) {
      void this.securityAlerts
        .alert('UPLOAD_MALWARE_BLOCKED', validated.sha256, { ...details, uploaderId, uploaderRole })
        .catch(() => undefined);
    }
  }

  /**
   * Deletes a stored upload (file + its MediaAsset rows) by its public URL. Callers must first make sure
   * nothing references the URL any more. Only /api/uploads/files/<key> URLs are touched.
   */
  async deleteStoredFile(fileUrl: string): Promise<boolean> {
    if (typeof fileUrl !== 'string' || !fileUrl.startsWith(UPLOAD_FILE_URL_PREFIX)) return false;
    const key = fileUrl.slice(UPLOAD_FILE_URL_PREFIX.length);
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(key) || key !== path.basename(key)) return false;
    const filePath = path.join(this.uploadDir, key);
    let removed = false;
    try {
      await fs.promises.unlink(filePath);
      removed = true;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
    await this.prisma.mediaAsset.deleteMany({ where: { fileUrl: fileUrlForStorageKey(key) } });
    return removed;
  }

  /**
   * A stored file is PUBLIC only if it was uploaded with a public purpose and is not linked
   * to a registration Document or TeamMember ID proof. Everything else (including files with
   * no MediaAsset record) is private and requires a signed URL, which is only issued to the
   * uploader or staff. All lookups are exact-equality on the indexed full file URL.
   */
  async isAssetPrivate(storageKey: string): Promise<boolean> {
    const fileUrl = fileUrlForStorageKey(storageKey);

    const [doc, member, publicAsset] = await Promise.all([
      this.prisma.document.findFirst({ where: { fileUrl }, select: { id: true } }),
      this.prisma.teamMember.findFirst({ where: { idProofUrl: fileUrl }, select: { id: true } }),
      this.prisma.mediaAsset.findFirst({ where: { fileUrl, isPublic: true }, select: { id: true } })
    ]);

    if (doc || member) return true;
    return !publicAsset;
  }

  generateSignedUrl(assetId: string, userId: string, userRole: string, ttlSeconds: number = 300) {
    return this.prisma.mediaAsset.findUnique({ where: { id: assetId } }).then((asset) => {
      if (!asset) {
        throw new NotFoundException(`Asset '${assetId}' not found`);
      }

      if (
        userRole !== UserRole.SUPER_ADMIN &&
        userRole !== UserRole.EVENT_ADMIN &&
        userRole !== UserRole.INSPECTOR &&
        asset.uploadedBy !== userId
      ) {
        throw new ForbiddenException('Access denied: You do not have permission to access this asset');
      }

      const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
      const secret = getSigningSecret();
      const storageKey = path.basename(asset.fileUrl);
      const signature = crypto
        .createHmac('sha256', secret)
        .update(`${storageKey}:${expires}`)
        .digest('hex');

      return {
        url: `${asset.fileUrl}?token=${signature}&expires=${expires}`,
        expiresAt: new Date(expires * 1000).toISOString()
      };
    });
  }

  verifySignedToken(storageKey: string, token?: string, expires?: string): boolean {
    if (!token || !expires) return false;
    const expiresNum = Number(expires);
    if (isNaN(expiresNum) || expiresNum < Math.floor(Date.now() / 1000)) {
      return false;
    }

    const safeKey = path.basename(storageKey);
    let secret: string;
    try {
      secret = getSigningSecret();
    } catch {
      return false;
    }
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${safeKey}:${expires}`)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  async getFileStream(storageKey: string) {
    // Prevent directory traversal
    const safeKey = path.basename(storageKey);
    const filePath = path.join(this.uploadDir, safeKey);

    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
      throw new NotFoundException('File not found in storage');
    }

    const asset = await this.prisma.mediaAsset.findFirst({
      where: { fileUrl: fileUrlForStorageKey(safeKey) },
      select: { mimeType: true, fileName: true }
    });

    // Encrypted (GCE1) files are decrypted and tag-verified in full before anything is sent (private files
    // are at most 10 MB); plaintext files (public imagery, legacy private uploads) are streamed from disk.
    const stream: Readable = (await this.hasEncryptionHeader(filePath))
      ? Readable.from([await this.decryptStoredFile(filePath, safeKey)])
      : fs.createReadStream(filePath);

    return {
      stream,
      mimeType: asset?.mimeType || 'application/octet-stream',
      fileName: asset?.fileName || safeKey
    };
  }

  /**
   * Stored file details for a ranged (HTTP Range) read: size on disk, type and whether the file is encrypted.
   * Encrypted files cannot be served in ranges (they are decrypted in full); callers answer 200 for them.
   */
  async statStoredFile(storageKey: string): Promise<{ filePath: string; size: number; mimeType: string; fileName: string; encrypted: boolean }> {
    const safeKey = path.basename(storageKey);
    const filePath = path.join(this.uploadDir, safeKey);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      throw new NotFoundException('File not found in storage');
    }
    if (!stat.isFile()) throw new NotFoundException('File not found in storage');
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { fileUrl: fileUrlForStorageKey(safeKey) },
      select: { mimeType: true, fileName: true }
    });
    return {
      filePath,
      size: stat.size,
      mimeType: asset?.mimeType || 'application/octet-stream',
      fileName: asset?.fileName || safeKey,
      encrypted: await this.hasEncryptionHeader(filePath)
    };
  }

  /** Plaintext byte range [start, end] (inclusive) of a stored, unencrypted file. */
  createRangeStream(filePath: string, start: number, end: number): Readable {
    return fs.createReadStream(filePath, { start, end });
  }

  /**
   * Plaintext of a stored upload by storage key or /api/uploads/files/<key> URL, for server-side readers
   * (document review, pass/certificate generation). Encrypted files are decrypted; legacy plaintext is
   * returned unchanged. 404 when missing, 500 (generic, security alert logged) when decryption fails.
   */
  async readStoredFile(storageKeyOrUrl: string): Promise<Buffer> {
    const safeKey = path.basename(String(storageKeyOrUrl || ''));
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(safeKey)) throw new NotFoundException('File not found in storage');
    const filePath = path.join(this.uploadDir, safeKey);
    let data: Buffer;
    try {
      data = await fs.promises.readFile(filePath);
    } catch {
      throw new NotFoundException('File not found in storage');
    }
    return isEncryptedFile(data) ? this.decryptOrFail(data, safeKey) : data;
  }

  private async hasEncryptionHeader(filePath: string): Promise<boolean> {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const probe = Buffer.alloc(FILE_ENCRYPTION_MAGIC.length);
      const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
      return bytesRead === probe.length && isEncryptedFile(probe);
    } finally {
      await handle.close();
    }
  }

  private async decryptStoredFile(filePath: string, safeKey: string): Promise<Buffer> {
    const data = await fs.promises.readFile(filePath);
    return this.decryptOrFail(data, safeKey);
  }

  /** Decrypts or throws a generic 500; a failed tag check (tampering or wrong key) raises a security alert. */
  private decryptOrFail(data: Buffer, safeKey: string): Buffer {
    try {
      return decryptFileBuffer(data, this.fileKey());
    } catch (err: any) {
      const reason = err instanceof FileDecryptionError ? err.message : 'Encryption key unavailable';
      this.logger.error(`Stored file ${safeKey} could not be decrypted: ${reason}`);
      if (this.securityAlerts) {
        void this.securityAlerts
          .alert('UPLOAD_DECRYPTION_FAILED', safeKey, { storageKey: safeKey, reason })
          .catch(() => undefined);
      }
      throw new InternalServerErrorException('The file could not be read.');
    }
  }
}
