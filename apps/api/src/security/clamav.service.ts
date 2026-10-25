import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import * as net from 'net';

export type ClamScanResult =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  | { status: 'disabled' }
  | { status: 'error'; reason: string };

export interface ClamAvConfig {
  host: string;
  port: number;
  required: boolean;
  timeoutMs: number;
}

const CHUNK_SIZE = 64 * 1024;
const MAX_RESPONSE_BYTES = 4096;

export function clamAvConfig(env: NodeJS.ProcessEnv = process.env): ClamAvConfig {
  const requiredRaw = String(env.CLAMAV_REQUIRED ?? '').trim().toLowerCase();
  const required = requiredRaw === '' ? env.NODE_ENV === 'production' : requiredRaw === 'true' || requiredRaw === '1';
  const port = Number(env.CLAMAV_PORT || 3310);
  const timeoutMs = Number(env.CLAMAV_TIMEOUT_MS || 15000);
  return {
    host: (env.CLAMAV_HOST || '').trim(),
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3310,
    required,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000
  };
}

/**
 * Minimal clamd client (INSTREAM over TCP): "zINSTREAM\0", then <uint32 BE length><bytes> chunks,
 * terminated by a zero-length chunk. clamd answers "stream: OK" or "stream: <Signature> FOUND".
 */
export function scanBufferWithClamd(buffer: Buffer, host: string, port: number, timeoutMs = 15000): Promise<ClamScanResult> {
  return new Promise((resolve) => {
    let settled = false;
    let response = '';
    const socket = new net.Socket();

    const finish = (result: ClamScanResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const interpret = () => {
      const reply = response.replace(/\0/g, '').trim();
      if (/^stream:\s*OK$/i.test(reply)) return finish({ status: 'clean' });
      const found = /^stream:\s*(.+?)\s+FOUND$/i.exec(reply);
      if (found) return finish({ status: 'infected', signature: found[1].slice(0, 200) });
      if (/size limit exceeded/i.test(reply)) return finish({ status: 'error', reason: 'INSTREAM size limit exceeded' });
      return finish({ status: 'error', reason: reply ? `unexpected reply: ${reply.slice(0, 200)}` : 'empty reply' });
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish({ status: 'error', reason: 'timeout' }));
    socket.on('error', (err: any) => finish({ status: 'error', reason: err?.code || err?.message || 'socket error' }));
    socket.on('data', (data: Buffer) => {
      response += data.toString('utf8');
      if (response.length > MAX_RESPONSE_BYTES) return finish({ status: 'error', reason: 'oversized reply' });
      // Replies are NUL-terminated with the z-prefixed command
      if (response.includes('\0')) interpret();
    });
    socket.on('end', () => interpret());
    socket.on('close', () => {
      if (!settled) interpret();
    });

    socket.connect(port, host, () => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
        const chunk = buffer.subarray(i, Math.min(i + CHUNK_SIZE, buffer.length));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length, 0);
        socket.write(len);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4)); // zero-length terminator
    });
  });
}

export const FILE_REJECTED_MESSAGE = 'The file was rejected by the security scan.';
export const SCANNER_UNAVAILABLE_MESSAGE =
  'File uploads are temporarily unavailable because the security scan service cannot be reached. Please try again later.';

/**
 * Upload malware scanning. Disabled when CLAMAV_HOST is empty. When the scanner cannot be reached the
 * upload fails closed (503) if CLAMAV_REQUIRED is true (default in production), otherwise it is accepted
 * with a logged warning.
 */
@Injectable()
export class ClamAvService {
  private readonly logger = new Logger('ClamAV');

  /** Resolves with the scan result; throws 503 when the scanner is required but unavailable. */
  async scan(buffer: Buffer): Promise<ClamScanResult> {
    const config = clamAvConfig();
    if (!config.host) return { status: 'disabled' };

    const result = await scanBufferWithClamd(buffer, config.host, config.port, config.timeoutMs);
    if (result.status === 'error') {
      if (config.required) {
        this.logger.error(`Malware scan unavailable (${result.reason}); upload refused (CLAMAV_REQUIRED).`);
        throw new HttpException(
          { statusCode: HttpStatus.SERVICE_UNAVAILABLE, code: 'SCANNER_UNAVAILABLE', message: SCANNER_UNAVAILABLE_MESSAGE },
          HttpStatus.SERVICE_UNAVAILABLE
        );
      }
      this.logger.warn(`Malware scan unavailable (${result.reason}); upload accepted without a scan (CLAMAV_REQUIRED=false).`);
    }
    return result;
  }
}

export function fileRejectedException(): HttpException {
  return new HttpException(
    { statusCode: HttpStatus.UNPROCESSABLE_ENTITY, code: 'FILE_REJECTED', message: FILE_REJECTED_MESSAGE },
    HttpStatus.UNPROCESSABLE_ENTITY
  );
}
