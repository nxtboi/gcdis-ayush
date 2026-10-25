import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { InternalServerErrorException } from '@nestjs/common';
import { UserRole } from '@gcdis/shared';
import { UploadsService } from '../apps/api/src/uploads/uploads.service';
import { ClamAvService } from '../apps/api/src/security/clamav.service';
import {
  FILE_ENCRYPTION_HEADER_BYTES,
  FILE_ENCRYPTION_TAG_BYTES,
  decryptFileBuffer,
  encryptFileBuffer,
  fileEncryptionConfigErrors,
  isEncryptedFile,
  resolveFileEncryptionKey
} from '../apps/api/src/uploads/file-encryption';
import { PdfGeneratorService } from '../apps/api/src/certificates/pdf-generator.service';
import { encryptExistingUploads } from '../scripts/encrypt-existing-uploads';

const ROOT = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const TEST_KEY = crypto.randomBytes(32).toString('hex');
const pdf = (body: string) => Buffer.from(`%PDF-1.4\n${body}\n%%EOF`);

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as any) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const savedEnv = { ...process.env };
function restoreEnv() {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
}

describe('GCE1 envelope (AES-256-GCM)', () => {
  const key = crypto.randomBytes(32);

  test('round trip, header layout, fresh IV per file', () => {
    const plain = pdf('secret id proof');
    const a = encryptFileBuffer(plain, key);
    const b = encryptFileBuffer(plain, key);
    expect(a.subarray(0, 4).toString('ascii')).toBe('GCE1');
    expect(a[4]).toBe(1);
    expect(a.length).toBe(FILE_ENCRYPTION_HEADER_BYTES + plain.length + FILE_ENCRYPTION_TAG_BYTES);
    expect(a.subarray(5, 17).equals(b.subarray(5, 17))).toBe(false);
    expect(a.includes(Buffer.from('secret id proof'))).toBe(false);
    expect(decryptFileBuffer(a, key).equals(plain)).toBe(true);
  });

  test('tampering with ciphertext, tag, IV or version fails authentication; wrong key fails', () => {
    const sealed = encryptFileBuffer(pdf('x'.repeat(100)), key);
    for (const offset of [4, 8, FILE_ENCRYPTION_HEADER_BYTES + 3, sealed.length - 1]) {
      const t = Buffer.from(sealed);
      t[offset] ^= 0x01;
      expect(() => decryptFileBuffer(t, key)).toThrow();
    }
    expect(() => decryptFileBuffer(sealed, crypto.randomBytes(32))).toThrow();
    expect(() => decryptFileBuffer(sealed.subarray(0, 20), key)).toThrow();
  });

  test('HKDF key from FILE_ENCRYPTION_KEY differs from the raw key and from the dev JWT-derived key', () => {
    const fromEnv = resolveFileEncryptionKey({ FILE_ENCRYPTION_KEY: TEST_KEY, NODE_ENV: 'test' } as any);
    expect(fromEnv.source).toBe('FILE_ENCRYPTION_KEY');
    expect(fromEnv.key.length).toBe(32);
    expect(fromEnv.key.equals(Buffer.from(TEST_KEY, 'hex'))).toBe(false);
    const dev = resolveFileEncryptionKey({ JWT_SECRET: 'dev-secret-for-tests-0123456789abcdef', NODE_ENV: 'development' } as any);
    expect(dev.source).toBe('DEV_JWT_SECRET');
    expect(dev.key.equals(fromEnv.key)).toBe(false);
    expect(() => resolveFileEncryptionKey({ JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'production' } as any)).toThrow(/required in production/);
  });
});

describe('UploadsService at-rest encryption', () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcdis-enc-uploads-'));
  let assets: any[];
  let alerts: any;
  let service: UploadsService;

  beforeEach(() => {
    restoreEnv();
    process.env.STORAGE_LOCAL_DIR = uploadDir;
    process.env.FILE_ENCRYPTION_KEY = TEST_KEY;
    process.env.CLAMAV_HOST = '';
    process.env.CLAMAV_REQUIRED = 'false';
    assets = [];
    const prisma: any = {
      mediaAsset: {
        create: jest.fn().mockImplementation(({ data }: any) => {
          const row = { id: `asset-${assets.length + 1}`, ...data };
          assets.push(row);
          return Promise.resolve(row);
        }),
        findFirst: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(assets.find((a) => a.fileUrl === where.fileUrl) || null)
        )
      }
    };
    alerts = { alert: jest.fn().mockResolvedValue(true) };
    service = new UploadsService(prisma, { logAction: jest.fn().mockResolvedValue({}) } as any, new ClamAvService(), alerts);
  });
  afterAll(() => {
    restoreEnv();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  const stored = (fileUrl: string) => fs.readFileSync(path.join(uploadDir, path.basename(fileUrl)));

  test('round trip: a private upload is encrypted on disk and served as the original bytes', async () => {
    const original = pdf('Aadhaar 1234 5678 9012');
    for (const purpose of ['ID_PROOF', 'DOCUMENT']) {
      const res = await service.processUpload(original, 'id.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, purpose);
      const onDisk = stored(res.fileUrl);
      expect(isEncryptedFile(onDisk)).toBe(true);
      expect(onDisk.includes(Buffer.from('Aadhaar'))).toBe(false);
      // Quota accounting / metadata still use the plaintext size
      expect(res.sizeBytes).toBe(original.length);
      const file = await service.getFileStream(path.basename(res.fileUrl));
      expect(file.mimeType).toBe('application/pdf');
      expect(file.fileName).toBe('id.pdf');
      expect((await readAll(file.stream)).equals(original)).toBe(true);
      expect((await service.readStoredFile(res.fileUrl)).equals(original)).toBe(true);
    }
  });

  test('public purposes are stored unencrypted', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharp = require('sharp');
    const png: Buffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#16a34a' } }).png().toBuffer();
    for (const purpose of ['SPONSOR_LOGO', 'GALLERY_IMAGE', 'SITE_IMAGE', 'CMS_MEDIA', 'CMS_BACKGROUND']) {
      const res = await service.processUpload(png, 'logo.png', 'admin-1', UserRole.SUPER_ADMIN, purpose);
      expect(res.isPublic).toBe(true);
      const onDisk = stored(res.fileUrl);
      expect(isEncryptedFile(onDisk)).toBe(false);
      expect(onDisk.subarray(1, 4).toString('ascii')).toBe('PNG');
    }
  });

  test('legacy plaintext private files (no header) are still served unchanged', async () => {
    const key = `${crypto.randomUUID()}_legacy.pdf`;
    const legacy = pdf('uploaded before encryption');
    fs.writeFileSync(path.join(uploadDir, key), legacy);
    assets.push({ fileUrl: `/api/uploads/files/${key}`, mimeType: 'application/pdf', fileName: 'old.pdf' });
    const file = await service.getFileStream(key);
    expect(file.mimeType).toBe('application/pdf');
    expect((await readAll(file.stream)).equals(legacy)).toBe(true);
    expect((await service.readStoredFile(key)).equals(legacy)).toBe(true);
  });

  test('a tampered encrypted file is rejected with a generic 500 and a security alert', async () => {
    const res = await service.processUpload(pdf('tamper me'), 'doc.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'DOCUMENT');
    const filePath = path.join(uploadDir, path.basename(res.fileUrl));
    const data = fs.readFileSync(filePath);
    data[data.length - 20] ^= 0xff;
    fs.writeFileSync(filePath, data);
    const err = await service.getFileStream(path.basename(res.fileUrl)).catch((e) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect(err.getStatus()).toBe(500);
    expect(JSON.stringify(err.getResponse())).not.toMatch(/tag|decrypt|key|GCM/i);
    expect(alerts.alert).toHaveBeenCalledWith('UPLOAD_DECRYPTION_FAILED', path.basename(res.fileUrl), expect.any(Object));
    await expect(service.readStoredFile(res.fileUrl)).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  test('a file encrypted under another key is rejected (500), never served as ciphertext', async () => {
    const key = `${crypto.randomUUID()}_other.pdf`;
    fs.writeFileSync(path.join(uploadDir, key), encryptFileBuffer(pdf('other key'), crypto.randomBytes(32)));
    await expect(service.getFileStream(key)).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  test('controller response headers are unchanged (Content-Type, Content-Disposition, nosniff)', () => {
    const controller = read('apps', 'api', 'src', 'uploads', 'uploads.controller.ts');
    expect(controller).toContain("res.setHeader('Content-Type', mimeType);");
    expect(controller).toContain("res.setHeader('X-Content-Type-Options', 'nosniff');");
    expect(controller).toContain('res.setHeader(\'Content-Disposition\', `${disposition}; filename="${safeFileName}"`);');
  });

  test('encryption happens after the malware scan and the image re-encode (scanner sees plaintext)', () => {
    const src = read('apps', 'api', 'src', 'uploads', 'uploads.service.ts');
    const scan = src.indexOf('this.clamAv.scan(validated.buffer)');
    const strip = src.indexOf('stripImageMetadata(validated.buffer');
    const encrypt = src.indexOf('encryptFileBuffer(finalBuffer');
    expect(scan).toBeGreaterThan(0);
    expect(strip).toBeGreaterThan(scan);
    expect(encrypt).toBeGreaterThan(strip);
  });
});

describe('Startup check (UploadsService#onModuleInit)', () => {
  afterEach(restoreEnv);
  const make = () => {
    process.env.STORAGE_LOCAL_DIR = path.join(os.tmpdir(), 'gcdis-enc-startup');
    return new UploadsService({} as any, {} as any, new ClamAvService());
  };

  test('production refuses to start without a strong FILE_ENCRYPTION_KEY', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    for (const bad of [undefined, '', 'REPLACE_WITH_64_HEX_CHARACTERS', '0'.repeat(64), 'ab'.repeat(32), '0123456789abcdef'.repeat(4), TEST_KEY.slice(0, 62)]) {
      if (bad === undefined) delete process.env.FILE_ENCRYPTION_KEY;
      else process.env.FILE_ENCRYPTION_KEY = bad;
      expect(() => make().onModuleInit()).toThrow(/FILE_ENCRYPTION_KEY/);
    }
    process.env.FILE_ENCRYPTION_KEY = TEST_KEY;
    expect(() => make().onModuleInit()).not.toThrow();
  });

  test('development without the key starts (JWT_SECRET-derived key, warning); a malformed key still fails', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'dev-secret-for-tests-0123456789abcdef';
    delete process.env.FILE_ENCRYPTION_KEY;
    const svc = make();
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    expect(() => svc.onModuleInit()).not.toThrow();
    expect(warn.mock.calls.join(' ')).toMatch(/development-only key derived from JWT_SECRET/);
    process.env.FILE_ENCRYPTION_KEY = 'not-hex';
    expect(fileEncryptionConfigErrors(process.env).length).toBeGreaterThan(0);
    expect(() => make().onModuleInit()).toThrow(/64 hexadecimal/);
  });

  test('the check lives in the uploads module, not main.ts; configuration documents the variable', () => {
    expect(read('apps', 'api', 'src', 'uploads', 'uploads.service.ts')).toMatch(/onModuleInit\(\): void \{\s+const errors = fileEncryptionConfigErrors/);
    for (const f of ['.env.example', path.join('apps', 'api', '.env.example')]) {
      const text = read(f);
      expect(text).toMatch(/^FILE_ENCRYPTION_KEY=$/m);
      expect(text).toContain("randomBytes(32).toString('hex')");
    }
    expect(read('docker-compose.prod.yml')).toContain('FILE_ENCRYPTION_KEY=${FILE_ENCRYPTION_KEY:?');
  });
});

describe('Invoice cache is encrypted at rest', () => {
  afterAll(restoreEnv);
  test('cached invoice PDFs are written encrypted and read back as PDF; legacy cache still read', async () => {
    process.env.FILE_ENCRYPTION_KEY = TEST_KEY;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcdis-enc-invoice-'));
    const svc: PdfGeneratorService = Object.create(PdfGeneratorService.prototype);
    Object.assign(svc, { storageDir: dir, logger: { warn: jest.fn() } });
    const data: any = {
      invoiceNumber: `order_${crypto.randomBytes(4).toString('hex')}`,
      teamName: 'AERO', teamId: 'GCDIS-2026-T001', institution: 'Institute', captainName: 'Captain Name',
      captainEmail: 'captain@example.test', category: 'D40', amount: 11200, gstAmount: 1200, baseAmount: 10000,
      paymentRef: 'pay_1', issuedDate: 'October 15, 2026'
    };
    const first = await svc.generateInvoicePdf(data);
    expect(first.subarray(0, 4).toString()).toBe('%PDF');
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const cachePath = path.join(dir, files[0]);
    expect(isEncryptedFile(fs.readFileSync(cachePath))).toBe(true);
    expect((await svc.generateInvoicePdf(data)).equals(first)).toBe(true);
    // Legacy plaintext cache file
    fs.writeFileSync(cachePath, first);
    expect((await svc.generateInvoicePdf(data)).equals(first)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('scripts/encrypt-existing-uploads.ts', () => {
  const key = crypto.randomBytes(32);
  let dir: string;
  const privatePlain = pdf('private legacy');
  const publicPlain = Buffer.from('\x89PNG public image bytes', 'latin1');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcdis-enc-migrate-'));
    fs.writeFileSync(path.join(dir, 'a_private.pdf'), privatePlain);
    fs.writeFileSync(path.join(dir, 'b_private.pdf'), privatePlain);
    fs.writeFileSync(path.join(dir, 'c_public.png'), publicPlain);
    fs.writeFileSync(path.join(dir, 'd_done.pdf'), encryptFileBuffer(pdf('already'), key));
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const isPrivate = (name: string) => !name.includes('public');
  const snapshot = () => Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f)).toString('hex')]));

  test('--dry-run counts private plaintext files and changes nothing', async () => {
    const before = snapshot();
    const r = await encryptExistingUploads({ dir, isPrivate, dryRun: true });
    expect(r).toMatchObject({ scanned: 4, alreadyEncrypted: 1, publicSkipped: 1, privatePlaintext: 2, encrypted: 0, failed: 0 });
    expect(r.files).toEqual(['a_private.pdf', 'b_private.pdf']);
    expect(snapshot()).toEqual(before);
  });

  test('encrypts private plaintext in place atomically and is idempotent', async () => {
    const r1 = await encryptExistingUploads({ dir, isPrivate, key });
    expect(r1).toMatchObject({ privatePlaintext: 2, encrypted: 2, failed: 0, alreadyEncrypted: 1, publicSkipped: 1 });
    for (const f of ['a_private.pdf', 'b_private.pdf']) {
      const data = fs.readFileSync(path.join(dir, f));
      expect(isEncryptedFile(data)).toBe(true);
      expect(decryptFileBuffer(data, key).equals(privatePlain)).toBe(true);
    }
    expect(fs.readFileSync(path.join(dir, 'c_public.png')).equals(publicPlain)).toBe(true);
    // No temp files left behind
    expect(fs.readdirSync(dir).sort()).toEqual(['.gitkeep', 'a_private.pdf', 'b_private.pdf', 'c_public.png', 'd_done.pdf']);

    const after = snapshot();
    const r2 = await encryptExistingUploads({ dir, isPrivate, key });
    expect(r2).toMatchObject({ alreadyEncrypted: 3, publicSkipped: 1, privatePlaintext: 0, encrypted: 0, failed: 0 });
    expect(snapshot()).toEqual(after);
  });

  test('a real run without a key is refused', async () => {
    await expect(encryptExistingUploads({ dir, isPrivate })).rejects.toThrow(/key is required/);
  });

  test('the script is wired as an npm script and writes via temp file + rename', () => {
    expect(JSON.parse(read('package.json')).scripts['uploads:encrypt']).toContain('scripts/encrypt-existing-uploads.ts');
    const src = read('scripts', 'encrypt-existing-uploads.ts');
    expect(src).toContain("fs.promises.open(tmpPath, 'wx'");
    expect(src).toContain('fs.promises.rename(tmpPath, filePath)');
  });
});
