import 'reflect-metadata';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { HttpException } from '@nestjs/common';
import {
  ClamAvService,
  clamAvConfig,
  scanBufferWithClamd,
  FILE_REJECTED_MESSAGE
} from '../apps/api/src/security/clamav.service';
import { UploadsService } from '../apps/api/src/uploads/uploads.service';
import { UserRole } from '@gcdis/shared';

const EICAR_MARKER = 'EICAR-TEST-PAYLOAD';

/**
 * Fake clamd: parses zINSTREAM framing (<uint32 BE length><bytes> ... <0>) and answers
 * "stream: Eicar-Test-Signature FOUND" when the reassembled stream contains EICAR_MARKER, else "stream: OK".
 */
function startFakeClamd(): Promise<{ port: number; received: Buffer[]; close: () => Promise<void> }> {
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let commandSeen = false;
    const chunks: Buffer[] = [];
    socket.on('data', (data) => {
      buf = Buffer.concat([buf, data]);
      if (!commandSeen) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        const command = buf.subarray(0, nul).toString();
        if (command !== 'zINSTREAM') {
          socket.end('UNKNOWN COMMAND\0');
          return;
        }
        commandSeen = true;
        buf = buf.subarray(nul + 1);
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          const stream = Buffer.concat(chunks);
          received.push(stream);
          socket.end(stream.includes(EICAR_MARKER) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buf.length < 4 + len) return;
        chunks.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, received, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** A port with nothing listening. */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const pdf = (body: string) => Buffer.from(`%PDF-1.4\n${body}\n%%EOF`);

describe('clamd INSTREAM client', () => {
  let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
  beforeAll(async () => {
    clamd = await startFakeClamd();
  });
  afterAll(async () => {
    await clamd.close();
  });

  test('clean stream -> clean; the whole buffer is streamed in chunks', async () => {
    const big = Buffer.concat([pdf('x'), Buffer.alloc(200 * 1024, 7)]);
    await expect(scanBufferWithClamd(big, '127.0.0.1', clamd.port)).resolves.toEqual({ status: 'clean' });
    expect(clamd.received[clamd.received.length - 1].equals(big)).toBe(true);
  });

  test('infected stream -> infected with the signature name', async () => {
    await expect(scanBufferWithClamd(pdf(EICAR_MARKER), '127.0.0.1', clamd.port)).resolves.toEqual({
      status: 'infected',
      signature: 'Eicar-Test-Signature'
    });
  });

  test('unreachable scanner -> error result (never throws)', async () => {
    const port = await closedPort();
    const result = await scanBufferWithClamd(pdf('x'), '127.0.0.1', port, 2000);
    expect(result.status).toBe('error');
  });

  test('config: disabled without host, required by default in production only', () => {
    expect(clamAvConfig({} as any)).toMatchObject({ host: '', port: 3310, required: false });
    expect(clamAvConfig({ NODE_ENV: 'production', CLAMAV_HOST: 'clamav' } as any)).toMatchObject({ host: 'clamav', required: true });
    expect(clamAvConfig({ NODE_ENV: 'production', CLAMAV_HOST: 'clamav', CLAMAV_REQUIRED: 'false' } as any).required).toBe(false);
    expect(clamAvConfig({ CLAMAV_HOST: 'h', CLAMAV_PORT: '9999', CLAMAV_REQUIRED: 'true' } as any)).toMatchObject({ port: 9999, required: true });
  });
});

describe('Upload malware scanning in UploadsService', () => {
  const env = { ...process.env };
  let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
  let prisma: any;
  let audit: any;
  let alerts: any;
  let service: UploadsService;
  const uploadDir = path.join(os.tmpdir(), `gcdis-r3-clamav-${process.pid}`);

  beforeAll(async () => {
    clamd = await startFakeClamd();
  });
  afterAll(async () => {
    await clamd.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.STORAGE_LOCAL_DIR = uploadDir;
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(clamd.port);
    process.env.CLAMAV_REQUIRED = 'true';
    prisma = { mediaAsset: { create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'asset-1', ...data })) } };
    audit = { logAction: jest.fn().mockResolvedValue({}) };
    alerts = { alert: jest.fn().mockResolvedValue(true) };
    service = new UploadsService(prisma, audit, new ClamAvService(), alerts);
  });
  afterEach(() => {
    process.env = { ...env };
  });

  const filesOnDisk = () => (fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0);

  test('clean file is scanned, stored and recorded', async () => {
    const before = filesOnDisk();
    const result = await service.processUpload(pdf('clean document'), 'doc.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'DOCUMENT');
    expect(result.assetId).toBe('asset-1');
    expect(filesOnDisk()).toBe(before + 1);
    expect(clamd.received[clamd.received.length - 1].toString()).toContain('clean document');
  });

  test('infected file -> 422 FILE_REJECTED, audit UPLOAD_MALWARE_BLOCKED, alert, nothing persisted', async () => {
    const before = filesOnDisk();
    const err: any = await service
      .processUpload(pdf(EICAR_MARKER), 'invoice.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'DOCUMENT')
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse()).toMatchObject({ code: 'FILE_REJECTED', message: FILE_REJECTED_MESSAGE });
    expect(FILE_REJECTED_MESSAGE).toBe('The file was rejected by the security scan.');
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
    expect(filesOnDisk()).toBe(before);
    expect(audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPLOAD_MALWARE_BLOCKED',
        actorId: 'cap-1',
        afterState: expect.objectContaining({ signature: 'Eicar-Test-Signature', sha256: expect.any(String) })
      })
    );
    expect(alerts.alert).toHaveBeenCalledWith('UPLOAD_MALWARE_BLOCKED', expect.any(String), expect.any(Object));
  });

  test('magic-byte check runs before the scan (unsupported types never reach clamd)', async () => {
    const count = clamd.received.length;
    await expect(
      service.processUpload(Buffer.from('MZ\x90\x00 not a document'), 'tool.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'DOCUMENT')
    ).rejects.toThrow();
    expect(clamd.received.length).toBe(count);
  });

  test('scanner unreachable + CLAMAV_REQUIRED=true -> 503, nothing persisted', async () => {
    process.env.CLAMAV_PORT = String(await closedPort());
    const err: any = await service.processUpload(pdf('x'), 'doc.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'DOCUMENT').catch((e) => e);
    expect(err.getStatus()).toBe(503);
    expect(err.getResponse()).toMatchObject({ code: 'SCANNER_UNAVAILABLE', message: expect.stringMatching(/^File uploads are temporarily unavailable/) });
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  test('scanner unreachable + CLAMAV_REQUIRED=false -> accepted with a warning', async () => {
    process.env.CLAMAV_PORT = String(await closedPort());
    process.env.CLAMAV_REQUIRED = 'false';
    await expect(service.processUpload(pdf('x'), 'doc.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'DOCUMENT')).resolves.toMatchObject({
      assetId: 'asset-1'
    });
  });

  test('CLAMAV_HOST empty -> scanning disabled (development)', async () => {
    process.env.CLAMAV_HOST = '';
    const count = clamd.received.length;
    await expect(service.processUpload(pdf('x'), 'doc.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'DOCUMENT')).resolves.toBeDefined();
    expect(clamd.received.length).toBe(count);
  });
});
