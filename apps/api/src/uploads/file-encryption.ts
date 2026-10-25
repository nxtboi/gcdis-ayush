import * as crypto from 'crypto';

/**
 * At-rest encryption for private stored files (ID proofs, team documents, cached invoices).
 *
 * Envelope ("GCE1", version 1), AES-256-GCM:
 *
 *   offset 0  : 4 bytes  magic "GCE1"
 *   offset 4  : 1 byte   version (0x01)
 *   offset 5  : 12 bytes random IV (per file)
 *   offset 17 : N bytes  ciphertext
 *   last 16   : 16 bytes GCM authentication tag
 *
 * The 17-byte header is bound to the ciphertext as additional authenticated data, so the version byte
 * and IV cannot be altered without the tag check failing. Files without the magic are legacy plaintext
 * and are served as they are (every accepted upload type begins with its own magic bytes, never "GCE1").
 *
 * The AES key is derived with HKDF-SHA256 from FILE_ENCRYPTION_KEY (64 hex characters = 32 bytes).
 * Outside production, when FILE_ENCRYPTION_KEY is empty, a development-only key is derived from
 * JWT_SECRET under a different HKDF label (a warning is logged). Production refuses to start without a
 * strong FILE_ENCRYPTION_KEY (UploadsService#onModuleInit).
 */
export const FILE_ENCRYPTION_MAGIC = Buffer.from('GCE1', 'ascii');
export const FILE_ENCRYPTION_VERSION = 1;
export const FILE_ENCRYPTION_IV_BYTES = 12;
export const FILE_ENCRYPTION_TAG_BYTES = 16;
export const FILE_ENCRYPTION_HEADER_BYTES = FILE_ENCRYPTION_MAGIC.length + 1 + FILE_ENCRYPTION_IV_BYTES;

const HKDF_SALT = Buffer.from('gcdis/file-encryption/salt/v1', 'utf8');
const HKDF_INFO = Buffer.from('gcdis/file-encryption/aes-256-gcm/v1', 'utf8');
const HKDF_INFO_DEV = Buffer.from('gcdis/file-encryption/aes-256-gcm/dev-from-jwt-secret/v1', 'utf8');

/** Thrown when an encrypted file cannot be decrypted (wrong key, truncated, or tampered: tag mismatch). */
export class FileDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileDecryptionError';
  }
}

export type FileKeySource = 'FILE_ENCRYPTION_KEY' | 'DEV_JWT_SECRET';

export interface ResolvedFileKey {
  key: Buffer;
  source: FileKeySource;
}

/** Problems with FILE_ENCRYPTION_KEY itself (empty list = usable). Never echoes the value. */
export function fileEncryptionKeyProblems(raw: string | undefined): string[] {
  const value = (raw || '').trim();
  if (!value) return ['FILE_ENCRYPTION_KEY is not set.'];
  const problems: string[] = [];
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    problems.push('FILE_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 random bytes).');
    return problems;
  }
  const lower = value.toLowerCase();
  // Placeholder / low-entropy values: a short unit repeated (000..., abab..., 0123456789abcdef x4) or few distinct digits
  if (/^(.{1,32})\1+$/.test(lower) || new Set(lower).size < 8) {
    problems.push('FILE_ENCRYPTION_KEY looks like a placeholder or low-entropy value; generate a random key.');
  }
  return problems;
}

/**
 * Startup check (run from UploadsService#onModuleInit). Production: FILE_ENCRYPTION_KEY must be a strong
 * 64-hex key. Any environment: a non-empty but malformed key is an error (never silently ignored).
 */
export function fileEncryptionConfigErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.FILE_ENCRYPTION_KEY || '').trim();
  if (env.NODE_ENV === 'production') {
    return fileEncryptionKeyProblems(raw).map((p) => `${p} It is required in production to encrypt private uploads.`);
  }
  return raw ? fileEncryptionKeyProblems(raw) : [];
}

const keyCache = new Map<string, ResolvedFileKey>();

/**
 * Resolves the file encryption key. Throws when no usable key exists (production without a valid
 * FILE_ENCRYPTION_KEY, or development without both FILE_ENCRYPTION_KEY and JWT_SECRET).
 */
export function resolveFileEncryptionKey(env: NodeJS.ProcessEnv = process.env): ResolvedFileKey {
  const raw = (env.FILE_ENCRYPTION_KEY || '').trim();
  const jwt = env.JWT_SECRET || '';
  const isProd = env.NODE_ENV === 'production';
  const cacheKey = crypto
    .createHash('sha256')
    .update(`${isProd ? 'p' : 'd'}\0${raw}\0${raw ? '' : jwt}`)
    .digest('hex');
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  let resolved: ResolvedFileKey;
  if (raw) {
    const problems = fileEncryptionKeyProblems(raw);
    if (problems.length) throw new Error(problems.join(' '));
    const ikm = Buffer.from(raw, 'hex');
    resolved = { key: Buffer.from(crypto.hkdfSync('sha256', ikm, HKDF_SALT, HKDF_INFO, 32)), source: 'FILE_ENCRYPTION_KEY' };
  } else {
    if (isProd) throw new Error('FILE_ENCRYPTION_KEY is required in production to encrypt private uploads.');
    if (!jwt) throw new Error('FILE_ENCRYPTION_KEY (or, outside production, JWT_SECRET) must be configured to encrypt private uploads.');
    resolved = {
      key: Buffer.from(crypto.hkdfSync('sha256', Buffer.from(jwt, 'utf8'), HKDF_SALT, HKDF_INFO_DEV, 32)),
      source: 'DEV_JWT_SECRET'
    };
  }
  if (keyCache.size > 16) keyCache.clear();
  keyCache.set(cacheKey, resolved);
  return resolved;
}

/** True when the buffer starts with the "GCE1" envelope magic. */
export function isEncryptedFile(data: Buffer): boolean {
  return data.length >= FILE_ENCRYPTION_MAGIC.length && data.subarray(0, FILE_ENCRYPTION_MAGIC.length).equals(FILE_ENCRYPTION_MAGIC);
}

/** Encrypts plaintext into the GCE1 envelope with a fresh random 12-byte IV. */
export function encryptFileBuffer(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('File encryption key must be 32 bytes');
  const iv = crypto.randomBytes(FILE_ENCRYPTION_IV_BYTES);
  const header = Buffer.concat([FILE_ENCRYPTION_MAGIC, Buffer.from([FILE_ENCRYPTION_VERSION]), iv]);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: FILE_ENCRYPTION_TAG_BYTES });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

/** Decrypts a GCE1 envelope, verifying the GCM tag. Throws FileDecryptionError on any failure. */
export function decryptFileBuffer(data: Buffer, key: Buffer): Buffer {
  if (!isEncryptedFile(data)) throw new FileDecryptionError('Not an encrypted file');
  if (data.length < FILE_ENCRYPTION_HEADER_BYTES + FILE_ENCRYPTION_TAG_BYTES) {
    throw new FileDecryptionError('Encrypted file is truncated');
  }
  const version = data[FILE_ENCRYPTION_MAGIC.length];
  if (version !== FILE_ENCRYPTION_VERSION) throw new FileDecryptionError(`Unsupported encrypted file version ${version}`);
  const header = data.subarray(0, FILE_ENCRYPTION_HEADER_BYTES);
  const iv = data.subarray(FILE_ENCRYPTION_MAGIC.length + 1, FILE_ENCRYPTION_HEADER_BYTES);
  const tag = data.subarray(data.length - FILE_ENCRYPTION_TAG_BYTES);
  const ciphertext = data.subarray(FILE_ENCRYPTION_HEADER_BYTES, data.length - FILE_ENCRYPTION_TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: FILE_ENCRYPTION_TAG_BYTES });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new FileDecryptionError('Encrypted file failed authentication (wrong key or modified data)');
  }
}

/** Returns the plaintext of a stored file: decrypted when it carries the envelope, unchanged (legacy) otherwise. */
export function decodeStoredFile(data: Buffer, key: Buffer): { plaintext: Buffer; encrypted: boolean } {
  if (!isEncryptedFile(data)) return { plaintext: data, encrypted: false };
  return { plaintext: decryptFileBuffer(data, key), encrypted: true };
}
