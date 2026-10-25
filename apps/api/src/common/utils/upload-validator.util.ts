import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { ClamAvService, fileRejectedException } from '../../security/clamav.service';

export interface ValidatedFileResult {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  buffer: Buffer;
}

export interface FileValidationOptions {
  maxSizeBytes?: number;
  allowedMimeTypes?: string[];
}

// Magic Byte Signatures for allowed file types
const MAGIC_SIGNATURES: Record<string, { bytes: number[]; offset?: number }> = {
  'application/pdf': { bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  'image/png': { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }, // .PNG\r\n\x1a\n
  'image/jpeg': { bytes: [0xff, 0xd8, 0xff] }, // JPEG SOI
  'image/webp': { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 } // 'WEBP' at offset 8 (RIFF....WEBP)
};

/** Video types accepted for the championship page hero video (EVENT_VIDEO uploads only). */
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'];

/** ISO-BMFF brands of MP4 video files (major or compatible brand). */
const MP4_VIDEO_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9',
  'mp41', 'mp42', 'mp71', 'avc1', 'av01', 'hvc1', 'hev1', 'dash', 'mmp4', 'MSNV', 'M4V ', 'M4VH', 'M4VP', 'XAVC'
]);
/** ISO-BMFF major brands that are not MP4 video: HEIF / AVIF images, audio-only M4A / M4B and QuickTime. */
const NON_MP4_VIDEO_MAJOR_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis', 'M4A ', 'M4B ', 'M4P ', 'qt  ']);

/**
 * Detects MP4 and WebM video by their headers:
 * - MP4: an ISO-BMFF `ftyp` box first (size at 0..3, 'ftyp' at 4..7) whose major or compatible brands name an
 *   MP4 video brand, and whose major brand is not an image, audio-only or QuickTime brand;
 * - WebM: the EBML magic 1A 45 DF A3 followed, within the EBML header, by the DocType "webm" (Matroska files
 *   carry "matroska" instead and are refused).
 * Returns null for anything else (never throws).
 */
export function detectVideoMimeType(buffer: Buffer): 'video/mp4' | 'video/webm' | null {
  if (!buffer || buffer.length < 12) return null;

  if (buffer.toString('latin1', 4, 8) === 'ftyp') {
    const boxSize = buffer.readUInt32BE(0);
    if (boxSize < 16 || boxSize > 512 || boxSize % 4 !== 0 || boxSize > buffer.length) return null;
    const major = buffer.toString('latin1', 8, 12);
    if (NON_MP4_VIDEO_MAJOR_BRANDS.has(major)) return null;
    const brands = [major];
    for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.push(buffer.toString('latin1', offset, offset + 4));
    return brands.some((b) => MP4_VIDEO_BRANDS.has(b)) ? 'video/mp4' : null;
  }

  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    // DocType element (ID 0x4282) inside the EBML header, which is always small
    const header = buffer.subarray(0, Math.min(buffer.length, 64));
    const docTypeAt = header.indexOf(Buffer.from([0x42, 0x82]));
    if (docTypeAt !== -1 && header.indexOf(Buffer.from('webm', 'latin1'), docTypeAt) !== -1) return 'video/webm';
    return null;
  }

  return null;
}

const DEFAULT_ALLOWED_MIMES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp'
];

// Anti-malware / EICAR test signature
export const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

let sharpModule: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sharpModule = require('sharp');
} catch {
  // Graceful fallback to pure binary stripper when sharp native binary is not installed
}

/**
 * Strips JPEG EXIF (APP1), ICC (APP2), Photoshop (APP13), and comment segments
 */
function stripJpegMetadata(buffer: Buffer): Buffer {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return buffer;
  }

  const chunks: Buffer[] = [buffer.slice(0, 2)]; // Start with SOI (0xFF 0xD8)
  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      // Resync / invalid segment, append remaining and break
      chunks.push(buffer.slice(offset));
      break;
    }

    const marker = buffer[offset + 1];

    // Standalone markers without length: SOI (0xD8), EOI (0xD9), RST (0xD0-0xD7)
    if (marker === 0xd9) {
      // EOI (End of Image)
      chunks.push(buffer.slice(offset, offset + 2));
      break;
    }

    if (marker >= 0xd0 && marker <= 0xd7) {
      chunks.push(buffer.slice(offset, offset + 2));
      offset += 2;
      continue;
    }

    if (offset + 4 > buffer.length) {
      chunks.push(buffer.slice(offset));
      break;
    }

    const segmentLen = buffer.readUInt16BE(offset + 2);
    const segmentEnd = offset + 2 + segmentLen;

    // Start of Scan (0xDA): Compressed image data begins here until EOI
    if (marker === 0xda) {
      chunks.push(buffer.slice(offset));
      break;
    }

    // Omit APP1 (EXIF: 0xE1), APP2 (ICC: 0xE2), APP13 (Photoshop: 0xED), COM (Comment: 0xFE)
    const isMetadata = marker === 0xe1 || marker === 0xe2 || marker === 0xed || marker === 0xfe;
    if (!isMetadata) {
      chunks.push(buffer.slice(offset, segmentEnd));
    }

    offset = segmentEnd;
  }

  return Buffer.concat(chunks);
}

/**
 * Strips PNG ancillary metadata chunks: eXIf, tEXt, zTXt, iTXt, tIME
 */
function stripPngMetadata(buffer: Buffer): Buffer {
  if (buffer.length < 8) return buffer;

  // PNG header is 8 bytes
  const header = buffer.slice(0, 8);
  const chunks: Buffer[] = [header];
  let offset = 8;

  const metadataChunkTypes = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

  while (offset + 8 <= buffer.length) {
    const chunkDataLen = buffer.readUInt32BE(offset);
    const chunkType = buffer.slice(offset + 4, offset + 8).toString('ascii');
    const totalChunkLen = 4 + 4 + chunkDataLen + 4; // length + type + data + crc

    if (offset + totalChunkLen > buffer.length) {
      chunks.push(buffer.slice(offset));
      break;
    }

    if (!metadataChunkTypes.has(chunkType)) {
      chunks.push(buffer.slice(offset, offset + totalChunkLen));
    }

    offset += totalChunkLen;
    if (chunkType === 'IEND') break;
  }

  return Buffer.concat(chunks);
}

/**
 * Re-encodes images with sharp to strip metadata (EXIF/ICC/XMP), with pure binary fallback
 */
export async function stripImageMetadata(buffer: Buffer, mimeType: string): Promise<Buffer> {
  if (sharpModule) {
    try {
      const sharpConstructor = sharpModule.default || sharpModule;
      // sharp auto-rotates and strips metadata by default
      return await sharpConstructor(buffer).rotate().toBuffer();
    } catch {
      // Fall through to binary stripper
    }
  }

  if (mimeType === 'image/jpeg') {
    return stripJpegMetadata(buffer);
  } else if (mimeType === 'image/png') {
    return stripPngMetadata(buffer);
  }

  return buffer;
}

/**
 * Malware check (kept for callers outside UploadsService): built-in signature check, then the clamd
 * INSTREAM scan through ClamAvService (CLAMAV_HOST / CLAMAV_PORT / CLAMAV_REQUIRED). Infected -> 422
 * FILE_REJECTED; scanner unavailable -> 503 when required, otherwise accepted.
 */
export async function scanWithClamAv(buffer: Buffer): Promise<boolean> {
  // 1. In-memory virus signature check (EICAR, malicious executables disguised as documents)
  const bufferString = buffer.slice(0, 2048).toString('utf-8');
  if (bufferString.includes(EICAR_SIGNATURE)) {
    throw new BadRequestException('Security Alert: Malicious file signature detected. Upload rejected.');
  }

  const result = await new ClamAvService().scan(buffer);
  if (result.status === 'infected') {
    throw fileRejectedException();
  }
  return true;
}

export function validateUploadedBuffer(
  buffer: Buffer,
  originalFilename: string,
  options?: FileValidationOptions
): ValidatedFileResult {
  const maxSize = options?.maxSizeBytes || 10 * 1024 * 1024; // 10MB default
  const allowedMimes = options?.allowedMimeTypes || DEFAULT_ALLOWED_MIMES;

  if (!buffer || buffer.length === 0) {
    throw new BadRequestException('Uploaded file buffer cannot be empty');
  }

  if (buffer.length > maxSize) {
    throw new BadRequestException(
      `File size (${(buffer.length / (1024 * 1024)).toFixed(2)} MB) exceeds maximum allowed limit of ${(maxSize / (1024 * 1024)).toFixed(2)} MB`
    );
  }

  // 1. Antivirus / Malicious Signature Scan
  const bufferString = buffer.slice(0, 1024).toString('utf-8');
  if (bufferString.includes(EICAR_SIGNATURE)) {
    throw new BadRequestException('Security Alert: Malicious file signature detected. Upload rejected.');
  }

  // 2. Magic-Byte Header Verification
  let detectedMimeType: string | null = null;

  for (const [mime, spec] of Object.entries(MAGIC_SIGNATURES)) {
    const offset = spec.offset || 0;
    if (buffer.length >= offset + spec.bytes.length) {
      let matches = true;
      for (let i = 0; i < spec.bytes.length; i++) {
        if (buffer[offset + i] !== spec.bytes[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        // Special check for WebP: must also start with RIFF at offset 0
        if (mime === 'image/webp') {
          const isRiff = buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46;
          if (isRiff) {
            detectedMimeType = mime;
            break;
          }
        } else {
          detectedMimeType = mime;
          break;
        }
      }
    }
  }

  // Video (only accepted where allowedMimeTypes lists it: EVENT_VIDEO uploads)
  if (!detectedMimeType) {
    detectedMimeType = detectVideoMimeType(buffer);
  }

  if (!detectedMimeType) {
    throw new BadRequestException(
      'Invalid file content: Magic-byte inspection failed. Disguised binary or unsupported format.'
    );
  }

  if (!allowedMimes.includes(detectedMimeType)) {
    throw new BadRequestException(
      `File MIME type '${detectedMimeType}' is not permitted. Allowed: ${allowedMimes.join(', ')}`
    );
  }

  // 3. Filename Sanitization & Traversal Prevention
  const sanitized = originalFilename
    .replace(/[^\w\.\-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(-100);

  // 4. SHA-256 Checksum calculation
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  return {
    fileName: sanitized,
    mimeType: detectedMimeType,
    sizeBytes: buffer.length,
    sha256,
    buffer
  };
}

/**
 * Reads pixel dimensions from a PNG, JPEG or WebP header without decoding the image.
 * Returns null when the header cannot be parsed (never throws).
 */
export function readImageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  try {
    if (!buffer || buffer.length < 24) return null;
    const ok = (w: number, h: number) => (w > 0 && h > 0 && w <= 100000 && h <= 100000 ? { width: w, height: h } : null);

    if (mimeType === 'image/png') {
      // IHDR is the first chunk: width/height at offsets 16/20
      if (buffer.slice(12, 16).toString('ascii') !== 'IHDR') return null;
      return ok(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
    }

    if (mimeType === 'image/jpeg') {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) return null;
        const marker = buffer[offset + 1];
        if (marker === 0xff) {
          offset += 1;
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        const len = buffer.readUInt16BE(offset + 2);
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return ok(buffer.readUInt16BE(offset + 7), buffer.readUInt16BE(offset + 5));
        }
        if (marker === 0xda || marker === 0xd9 || len < 2) return null;
        offset += 2 + len;
      }
      return null;
    }

    if (mimeType === 'image/webp') {
      const chunk = buffer.slice(12, 16).toString('ascii');
      if (chunk === 'VP8X' && buffer.length >= 30) {
        return ok(1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3));
      }
      if (chunk === 'VP8 ' && buffer.length >= 30) {
        return ok(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
      }
      if (chunk === 'VP8L' && buffer.length >= 25) {
        const b = buffer.readUInt32LE(21);
        return ok((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1);
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}
