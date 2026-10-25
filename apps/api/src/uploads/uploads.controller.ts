import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  Res,
  ForbiddenException,
  BadRequestException,
  UseInterceptors,
  UploadedFile,
  ParseUUIDPipe,
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Type
} from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  STREAM_UPLOAD_MAX_BYTES,
  UploadsService,
  VIDEO_UPLOAD_PURPOSE,
  videoUploadMaxBytes
} from './uploads.service';
import { AuthGuard } from '@nestjs/passport';
import { AccountIpRateLimiterGuard, RateLimit } from '../common/guards/rate-limiter.guard';
import { Public } from '../common/decorators/public.decorator';
import { UploadFileDto } from './dto/upload-file.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@gcdis/shared';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { AllowAudienceRoles, AudienceRolesGuard } from '../auth/audience-roles.guard';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { StaffStepUpGuard } from '../auth/step-up.guard';

/**
 * Upload rate limit per upload route: 20 uploads per 10 minutes per account (and client IP), and at
 * most 40 per 10 minutes from one IP address. Together with the per-captain storage quota in
 * UploadsService this bounds how fast and how far one account can fill the upload volume.
 */
export const UPLOAD_RATE_LIMIT = Object.freeze({
  points: 20,
  duration: 600,
  ipPoints: 40,
  message: 'Too many uploads in a short time. Please wait {wait} before uploading again.'
});

/**
 * Uploads are a captain action on portal sessions (team documents, ID proofs). Content
 * admins keep their admin-session uploads (CMS backgrounds / media); purpose-level checks in
 * UploadsService still restrict CMS purposes to SUPER_ADMIN / EVENT_ADMIN.
 */
const UPLOADERS = {
  public: [UserRole.TEAM_CAPTAIN],
  admin: [UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN]
};

/** Signed URLs: captains for their own uploads; staff who review documents (incl. inspectors). */
const SIGNED_URL_READERS = {
  public: [UserRole.TEAM_CAPTAIN],
  admin: [UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.INSPECTOR]
};

/**
 * Multipart limits of POST /uploads/stream. Every purpose keeps the 25 MB limit; only an administrator
 * uploading the championship hero video (`?purpose=EVENT_VIDEO` on the URL, so the limit is known before the
 * body is read) gets the EVENT_VIDEO limit (UPLOAD_VIDEO_MAX_MB, default 60 MB). The purpose form field, when
 * sent, must then also be EVENT_VIDEO (see uploadFileStream).
 */
export function streamUploadLimit(req: any): number {
  const queryPurpose = typeof req?.query?.purpose === 'string' ? req.query.purpose : undefined;
  const role = req?.user?.role;
  const isAdmin = role === UserRole.SUPER_ADMIN || role === UserRole.EVENT_ADMIN;
  return queryPurpose === VIDEO_UPLOAD_PURPOSE && isAdmin
    ? Math.max(videoUploadMaxBytes(), STREAM_UPLOAD_MAX_BYTES)
    : STREAM_UPLOAD_MAX_BYTES;
}

/** Runs multer with the limit chosen by streamUploadLimit (the guards have already authenticated the request). */
@Injectable()
export class StreamUploadInterceptor implements NestInterceptor {
  private readonly byLimit = new Map<number, NestInterceptor>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> | Promise<Observable<any>> {
    const fileSize = streamUploadLimit(context.switchToHttp().getRequest());
    let interceptor = this.byLimit.get(fileSize);
    if (!interceptor) {
      const Multer: Type<NestInterceptor> = FileInterceptor('file', {
        limits: {
          fileSize, // fileSize: 25 * 1024 * 1024 for every purpose except an administrator's EVENT_VIDEO upload
          files: 1
        }
      });
      interceptor = new Multer();
      this.byLimit.set(fileSize, interceptor);
    }
    return interceptor.intercept(context, next);
  }
}

/** Actor email, client IP and user agent recorded with the FILE_UPLOAD audit entry. */
function uploadAuditContext(req: any): { actorEmail?: string; ipAddress?: string; userAgent?: string } {
  return { actorEmail: req?.user?.email, ipAddress: req?.ip, userAgent: req?.headers?.['user-agent'] };
}

@Controller('uploads')
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  /**
   * Multipart Streaming Upload Endpoint with Size/File Limits (25 MB; an administrator's EVENT_VIDEO upload:
   * UPLOAD_VIDEO_MAX_MB, see StreamUploadInterceptor).
   * Captains must have confirmed their email address (EmailVerifiedGuard; staff pass). It is listed
   * first because stacked @UseGuards run bottom-up, so it runs after authentication. Guards run
   * before the file interceptor reads the body.
   */
  @UseGuards(EmailVerifiedGuard)
  @UseGuards(AuthGuard('jwt'), AudienceRolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @AllowAudienceRoles(UPLOADERS)
  @RateLimit({ ...UPLOAD_RATE_LIMIT })
  @Post('stream')
  @UseInterceptors(StreamUploadInterceptor)
  async uploadFileStream(
    @Request() req: any,
    @UploadedFile() file: any,
    @Body('purpose') purpose?: string,
    @Query('purpose') queryPurpose?: string
  ) {
    if (!file || !file.buffer) {
      throw new BadRequestException('No file uploaded or missing file stream buffer');
    }
    // The URL purpose selects the multipart limit, so a different form purpose is refused
    if (typeof queryPurpose === 'string' && typeof purpose === 'string' && purpose !== '' && purpose !== queryPurpose) {
      throw new BadRequestException('The purpose in the URL and in the form do not match.');
    }
    const effectivePurpose = purpose || (typeof queryPurpose === 'string' ? queryPurpose : '') || 'DOCUMENT';
    // Defence in depth: only EVENT_VIDEO uploads may exceed the 25 MB multipart limit
    if (file.buffer.length > STREAM_UPLOAD_MAX_BYTES && effectivePurpose !== VIDEO_UPLOAD_PURPOSE) {
      throw new BadRequestException('File too large');
    }

    return this.uploadsService.processUpload(
      file.buffer,
      file.originalname || 'uploaded_file',
      req.user.id,
      req.user.role,
      effectivePurpose,
      uploadAuditContext(req)
    );
  }

  /**
   * JSON Base64 Upload Endpoint (Backwards-compatible); same guards and limits as /uploads/stream.
   */
  @UseGuards(EmailVerifiedGuard)
  @UseGuards(AuthGuard('jwt'), AudienceRolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @AllowAudienceRoles(UPLOADERS)
  @RateLimit({ ...UPLOAD_RATE_LIMIT })
  @Post()
  async uploadFile(
    @Request() req: any,
    @Body() body: UploadFileDto
  ) {
    // Videos are uploaded through the multipart route only (they exceed the JSON body limit)
    if (body.purpose === VIDEO_UPLOAD_PURPOSE) {
      throw new BadRequestException('Videos must be uploaded with POST /uploads/stream.');
    }
    // Strip data URL scheme prefix if present (e.g. data:image/png;base64,...)
    const base64Clean = body.base64Data.replace(/^data:[\w/\-+.]+;base64,/, '');
    const buffer = Buffer.from(base64Clean, 'base64');

    return this.uploadsService.processUpload(
      buffer,
      body.fileName,
      req.user.id,
      req.user.role,
      body.purpose || 'DOCUMENT',
      uploadAuditContext(req)
    );
  }

  // Staff opening an uploaded ID proof or document must have confirmed their identity recently (step-up);
  // team captains opening their own files are not affected
  @UseGuards(AuthGuard('jwt'), AudienceRolesGuard, StaffStepUpGuard)
  @AllowAudienceRoles(SIGNED_URL_READERS)
  @Get('signed-url/:assetId')
  async getSignedUrl(@Param('assetId', new ParseUUIDPipe()) assetId: string, @Request() req: any) {
    return this.uploadsService.generateSignedUrl(assetId, req.user.id, req.user.role);
  }

  @Public()
  @Get('files/:key')
  async getFile(
    @Param('key') key: string,
    @Query('token') token: string,
    @Query('expires') expires: string,
    @Res() res: any,
    @Request() req?: any
  ) {
    const isPrivate = await this.uploadsService.isAssetPrivate(key);
    if (isPrivate) {
      const valid = this.uploadsService.verifySignedToken(key, token, expires);
      if (!valid) {
        throw new ForbiddenException('Invalid or expired signed URL for private asset');
      }
    }

    // Public videos are served with HTTP Range support (Safari / iOS need 206 responses to play and seek)
    if (!isPrivate && (await this.serveRangedVideo(key, req, res))) return;

    const { stream, mimeType, fileName } = await this.uploadsService.getFileStream(key);

    // Security Headers: Prevent MIME confusion and force attachment download for non-images
    res.setHeader('Content-Type', mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Private files (unlinked uploads, documents, ID proofs) must never be stored by shared caches/CDNs.
    res.setHeader('Cache-Control', isPrivate ? 'private, no-store' : 'public, max-age=86400, immutable');
    // Public site imagery (public-purpose uploads) is embedded by the public site and the staff console
    // from other origins; helmet's same-origin CORP stays in force for private files and all other responses.
    res.setHeader('Cross-Origin-Resource-Policy', isPrivate ? 'same-origin' : 'cross-origin');

    const isImage = mimeType.startsWith('image/');
    const disposition = isImage ? 'inline' : 'attachment';
    const safeFileName = String(fileName).replace(/[^A-Za-z0-9._ -]/g, '_');
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeFileName}"`);

    stream.pipe(res);
  }

  /**
   * Serves a public, unencrypted MP4 / WebM video with byte-range support. Returns false (nothing sent) for any
   * other file, which then takes the regular path. Single ranges only (`bytes=a-b`, `bytes=a-`, `bytes=-n`);
   * an unsatisfiable or malformed byte range is answered 416 with `Content-Range: bytes *` + `/size`; other
   * range units and multi-range requests get the whole file (200).
   */
  private async serveRangedVideo(key: string, req: any, res: any): Promise<boolean> {
    if (typeof (this.uploadsService as any).statStoredFile !== 'function') return false;
    let info: Awaited<ReturnType<UploadsService['statStoredFile']>>;
    try {
      info = await this.uploadsService.statStoredFile(key);
    } catch {
      // Missing file and other errors: the regular path answers them as before
      return false;
    }
    if (info.encrypted || (info.mimeType !== 'video/mp4' && info.mimeType !== 'video/webm')) return false;

    res.setHeader('Content-Type', info.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Accept-Ranges', 'bytes');
    const safeFileName = String(info.fileName).replace(/[^A-Za-z0-9._ -]/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${safeFileName}"`);

    const range = parseByteRange(req?.headers?.range, info.size);
    if (range === 'unsatisfiable') {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${info.size}`);
      res.setHeader('Content-Length', '0');
      res.end();
      return true;
    }
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
      this.uploadsService.createRangeStream(info.filePath, range.start, range.end).pipe(res);
      return true;
    }
    res.status(200);
    res.setHeader('Content-Length', String(info.size));
    if (info.size === 0) {
      res.end();
      return true;
    }
    this.uploadsService.createRangeStream(info.filePath, 0, info.size - 1).pipe(res);
    return true;
  }
}

/**
 * Parses a Range header against a file size: null = serve the whole file (no header, another unit or several
 * ranges), 'unsatisfiable' = 416, otherwise the inclusive byte range (end clamped to the last byte).
 */
export function parseByteRange(header: unknown, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (typeof header !== 'string' || header.trim() === '') return null;
  const value = header.trim();
  const unit = /^([A-Za-z]+)=/.exec(value);
  if (!unit || unit[1].toLowerCase() !== 'bytes') return null;
  const spec = value.slice(unit[0].length).trim();
  if (spec.includes(',')) return null;
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m || (m[1] === '' && m[2] === '')) return 'unsatisfiable';
  if (size <= 0) return 'unsatisfiable';
  if (m[1] === '') {
    // Suffix range: the last n bytes
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return 'unsatisfiable';
    return { start: Math.max(size - n, 0), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}
