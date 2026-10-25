import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { AccountIpRateLimiterGuard } from '../common/guards/rate-limiter.guard';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 5 * 60;
/** Failed attempts are forgotten this long after the latest failure. */
const ATTEMPT_WINDOW_SECONDS = 15 * 60;
/** Key prefix of the 2FA attempt counters in the shared rate-limit store. */
const ATTEMPT_KEY_PREFIX = 'auth2fa:';
const MIN_KEY_LENGTH = 32;

/** Crockford base32 (no I, L, O, U), used for recovery codes. */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_GROUPS = 4;
const RECOVERY_CODE_GROUP_LENGTH = 4;
/** Version tag stored on HMAC-protected recovery-code records. */
export const RECOVERY_CODE_FORMAT_VERSION = 2;
const RECOVERY_CODE_KEY_LABEL = 'gcdis-2fa-recovery-code-hmac-v2';
const MAX_SUBMITTED_RECOVERY_CODE_LENGTH = 64;

/**
 * A stored recovery code. `v: 2` = HMAC-SHA256 of the canonical code under the server key;
 * no `v` = legacy unsalted SHA-256 written by older builds.
 */
export type RecoveryCodeRecord = {
  hash: string;
  used: boolean;
  usedAt?: string;
  v?: number;
};

@Injectable()
export class TwoFactorService {
  private static ephemeralDevSecret: string | null = null;

  /**
   * Derives the 32-byte AES-256-GCM key for 2FA secrets at rest.
   * - TWO_FACTOR_ENCRYPTION_KEY (dedicated, >= 32 chars) when configured
   * - otherwise an HMAC-derived subkey of JWT_SECRET (never a hardcoded literal)
   */
  private getEncryptionKey(): Buffer {
    const dedicated = process.env.TWO_FACTOR_ENCRYPTION_KEY;
    if (dedicated) {
      if (dedicated.length < MIN_KEY_LENGTH && process.env.NODE_ENV === 'production') {
        throw new Error('FATAL: TWO_FACTOR_ENCRYPTION_KEY must be at least 32 characters in production');
      }
      return crypto.createHash('sha256').update(dedicated).digest();
    }
    return crypto.createHmac('sha256', this.requireJwtSecret()).update('gcdis-2fa-totp-encryption-v1').digest();
  }

  /**
   * Keys tried (after the current key) when decrypting secrets written by older builds,
   * which used sha256(JWT_SECRET) when TWO_FACTOR_ENCRYPTION_KEY was unset.
   */
  private getLegacyDecryptionKeys(): Buffer[] {
    if (process.env.TWO_FACTOR_ENCRYPTION_KEY || !process.env.JWT_SECRET) return [];
    return [crypto.createHash('sha256').update(process.env.JWT_SECRET).digest()];
  }

  /**
   * Production: JWT_SECRET (>= 32 chars) is mandatory when TWO_FACTOR_ENCRYPTION_KEY is unset.
   * Outside production with no secret at all (unit tests), an ephemeral per-process random key is
   * used instead of any hardcoded literal; such ciphertexts do not survive a restart.
   */
  private requireJwtSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (secret && (secret.length >= MIN_KEY_LENGTH || process.env.NODE_ENV !== 'production')) {
      return secret;
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: JWT_SECRET (>= 32 chars) or TWO_FACTOR_ENCRYPTION_KEY is required for 2FA secret encryption');
    }
    if (!TwoFactorService.ephemeralDevSecret) {
      TwoFactorService.ephemeralDevSecret = crypto.randomBytes(32).toString('hex');
    }
    return TwoFactorService.ephemeralDevSecret;
  }

  /**
   * Encodes binary buffer to RFC 3548 Base32 string.
   */
  encodeBase32(buffer: Buffer): string {
    let bits = 0;
    let value = 0;
    let output = '';

    for (let i = 0; i < buffer.length; i++) {
      value = (value << 8) | buffer[i];
      bits += 8;

      while (bits >= 5) {
        output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }

    if (bits > 0) {
      output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }

    return output;
  }

  /**
   * Decodes RFC 3548 Base32 string to binary buffer.
   */
  decodeBase32(input: string): Buffer {
    const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];

    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];
      const val = BASE32_ALPHABET.indexOf(char);
      if (val === -1) continue;

      value = (value << 5) | val;
      bits += 5;

      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }

    return Buffer.from(bytes);
  }

  /**
   * Generates a new random 20-byte Base32 TOTP secret.
   */
  generateBase32Secret(): string {
    const randomBytes = crypto.randomBytes(20);
    return this.encodeBase32(randomBytes);
  }

  /**
   * Encrypts plaintext TOTP secret with AES-256-GCM.
   * Format: <iv_hex>:<authTag_hex>:<ciphertext_hex>
   */
  encryptSecret(secret: string): string {
    const key = this.getEncryptionKey();
    const iv = crypto.randomBytes(12); // Standard 96-bit IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const ciphertext = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
  }

  /**
   * Decrypts AES-256-GCM encrypted secret.
   */
  decryptSecret(encrypted: string): string {
    try {
      const parts = encrypted.split(':');
      if (parts.length !== 3) {
        // Fallback for unencrypted legacy or hex strings
        return encrypted;
      }

      const [ivHex, authTagHex, ciphertextHex] = parts;
      const keys = [this.getEncryptionKey(), ...this.getLegacyDecryptionKeys()];
      for (const key of keys) {
        try {
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
          decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
          const decrypted = Buffer.concat([
            decipher.update(Buffer.from(ciphertextHex, 'hex')),
            decipher.final()
          ]);
          return decrypted.toString('utf8');
        } catch {
          // try next key
        }
      }
      throw new Error('no key could decrypt the secret');
    } catch (err) {
      throw new BadRequestException('Failed to decrypt two-factor authentication secret');
    }
  }

  /**
   * Computes 6-digit TOTP code for a specific time step (RFC 6238 / RFC 4226).
   */
  computeTotp(base32Secret: string, stepCounter: number): string {
    const secretBuffer = this.decodeBase32(base32Secret);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigInt64BE(BigInt(stepCounter));

    const hmac = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);

    const otp = (binary % 1000000).toString();
    return otp.padStart(6, '0');
  }

  /**
   * Verifies TOTP code with ±1 window, replay protection, and timingSafeEqual.
   */
  verifyTotp(
    base32Secret: string,
    code: string,
    lastUsedStep?: number | null
  ): { isValid: boolean; matchedStep?: number } {
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return { isValid: false };
    }

    const timeStepSeconds = 30;
    const currentStep = Math.floor(Date.now() / 1000 / timeStepSeconds);
    const candidateSteps = [currentStep, currentStep - 1, currentStep + 1];

    const inputBuf = Buffer.from(code);

    for (const step of candidateSteps) {
      // Replay protection: cannot reuse same step or earlier step than last used
      if (lastUsedStep !== undefined && lastUsedStep !== null && step <= lastUsedStep) {
        continue;
      }

      const expectedCode = this.computeTotp(base32Secret, step);
      const expectedBuf = Buffer.from(expectedCode);

      if (inputBuf.length === expectedBuf.length && crypto.timingSafeEqual(inputBuf, expectedBuf)) {
        return { isValid: true, matchedStep: step };
      }
    }

    return { isValid: false };
  }

  /**
   * Server key for recovery-code HMACs: a subkey of the 2FA encryption key (TWO_FACTOR_ENCRYPTION_KEY,
   * or the JWT_SECRET-derived fallback) under a distinct label, so it is never reused for encryption.
   */
  private getRecoveryCodeKey(): Buffer {
    return crypto.createHmac('sha256', this.getEncryptionKey()).update(RECOVERY_CODE_KEY_LABEL).digest();
  }

  /**
   * Canonical form of a v2 recovery code: 16 Crockford base32 characters grouped as XXXX-XXXX-XXXX-XXXX.
   * Case, spaces and hyphens are ignored and the Crockford aliases (I/L -> 1, O -> 0) are folded.
   * Returns null when the input cannot be a v2 code.
   */
  static normalizeRecoveryCode(input: string): string | null {
    if (typeof input !== 'string') return null;
    const compact = input
      .toUpperCase()
      .replace(/[\s-]+/g, '')
      .replace(/[IL]/g, '1')
      .replace(/O/g, '0');
    if (compact.length !== RECOVERY_CODE_GROUPS * RECOVERY_CODE_GROUP_LENGTH) return null;
    for (const ch of compact) {
      if (!CROCKFORD_ALPHABET.includes(ch)) return null;
    }
    const groups: string[] = [];
    for (let i = 0; i < compact.length; i += RECOVERY_CODE_GROUP_LENGTH) {
      groups.push(compact.slice(i, i + RECOVERY_CODE_GROUP_LENGTH));
    }
    return groups.join('-');
  }

  /** HMAC-SHA256 (hex) of a canonical v2 recovery code under the server recovery-code key. */
  hashRecoveryCode(canonicalCode: string): string {
    return crypto.createHmac('sha256', this.getRecoveryCodeKey()).update(canonicalCode).digest('hex');
  }

  /**
   * Generates 10 recovery codes, each 16 Crockford base32 characters (80 bits of entropy),
   * formatted XXXX-XXXX-XXXX-XXXX. Only an HMAC-SHA256 of each code is stored ({ hash, used, v: 2 }).
   */
  generateRecoveryCodes(): { plaintextCodes: string[]; hashedRecords: RecoveryCodeRecord[] } {
    const plaintextCodes: string[] = [];
    const hashedRecords: RecoveryCodeRecord[] = [];
    const length = RECOVERY_CODE_GROUPS * RECOVERY_CODE_GROUP_LENGTH;

    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      // 32 is a power of two and divides 256, so `byte & 31` is an unbiased pick from the alphabet
      const bytes = crypto.randomBytes(length);
      let compact = '';
      for (let j = 0; j < length; j++) compact += CROCKFORD_ALPHABET[bytes[j] & 31];
      const code = TwoFactorService.normalizeRecoveryCode(compact) as string;

      plaintextCodes.push(code);
      hashedRecords.push({ hash: this.hashRecoveryCode(code), used: false, v: RECOVERY_CODE_FORMAT_VERSION });
    }

    return { plaintextCodes, hashedRecords };
  }

  /**
   * Verifies a recovery code and returns the records with it marked as used. The caller persists the
   * update with a compare-and-swap so a code is consumed exactly once.
   * - v2 records ({ v: 2 }) hold an HMAC-SHA256 of the canonical code
   * - legacy records (no `v`) hold an unsalted SHA-256 of the trimmed, upper-cased XXXX-XXXX code and
   *   are still accepted so nobody is locked out; they disappear when the codes are next reissued
   * All comparisons use timingSafeEqual and every record is examined.
   */
  verifyRecoveryCode(
    submittedCode: string,
    storedRecords: RecoveryCodeRecord[]
  ): { isValid: boolean; updatedRecords?: RecoveryCodeRecord[] } {
    if (!submittedCode || typeof submittedCode !== 'string' || !Array.isArray(storedRecords)) {
      return { isValid: false };
    }
    if (submittedCode.length > MAX_SUBMITTED_RECOVERY_CODE_LENGTH) {
      return { isValid: false };
    }

    const canonical = TwoFactorService.normalizeRecoveryCode(submittedCode);
    const hasV2Records = storedRecords.some((r) => r && r.v === RECOVERY_CODE_FORMAT_VERSION);
    const hasLegacyRecords = storedRecords.some((r) => r && r.v === undefined);
    const v2Buf = canonical && hasV2Records ? Buffer.from(this.hashRecoveryCode(canonical), 'hex') : null;
    const legacyBuf = hasLegacyRecords
      ? crypto.createHash('sha256').update(submittedCode.trim().toUpperCase()).digest()
      : null;

    let matchIndex = -1;
    for (let i = 0; i < storedRecords.length; i++) {
      const record = storedRecords[i];
      if (!record || typeof record.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(record.hash)) continue;

      const candidate = record.v === RECOVERY_CODE_FORMAT_VERSION ? v2Buf : record.v === undefined ? legacyBuf : null;
      if (!candidate) continue;

      const recordBuf = Buffer.from(record.hash, 'hex');
      const equal = recordBuf.length === candidate.length && crypto.timingSafeEqual(candidate, recordBuf);
      if (equal && !record.used && matchIndex === -1) matchIndex = i;
    }

    if (matchIndex === -1) return { isValid: false };

    const updated = [...storedRecords];
    updated[matchIndex] = {
      ...storedRecords[matchIndex],
      used: true,
      usedAt: new Date().toISOString()
    };
    return { isValid: true, updatedRecords: updated };
  }

  /**
   * Per-user 2FA verification rate limiter (5 failed attempts in 15 minutes -> 5 minute lockout).
   * Counters live in the shared rate-limit store (Redis when available, per-instance memory
   * otherwise), so they survive API restarts and apply across replicas.
   */
  async checkUserRateLimit(userId: string): Promise<void> {
    const lock = await AccountIpRateLimiterGuard.readCounter(TwoFactorService.lockKey(userId));
    if (lock) {
      throw new UnauthorizedException(
        `Too many failed 2FA attempts for this account. Please wait ${Math.max(1, lock.ttl)} seconds before trying again.`
      );
    }
  }

  async recordFailedAttempt(userId: string): Promise<void> {
    const { count } = await AccountIpRateLimiterGuard.incrementCounter(
      TwoFactorService.failKey(userId),
      ATTEMPT_WINDOW_SECONDS,
      true
    );
    if (count >= MAX_FAILED_ATTEMPTS) {
      await AccountIpRateLimiterGuard.setCounter(TwoFactorService.lockKey(userId), 1, LOCKOUT_SECONDS);
      // The lock replaces the failure count: after it expires the user starts again from zero
      await AccountIpRateLimiterGuard.deleteCounters(TwoFactorService.failKey(userId));
    }
  }

  /** True while the user is locked out after MAX_FAILED_ATTEMPTS failures. */
  async isLocked(userId: string): Promise<boolean> {
    return (await AccountIpRateLimiterGuard.readCounter(TwoFactorService.lockKey(userId))) !== null;
  }

  async clearUserAttempts(userId: string): Promise<void> {
    await AccountIpRateLimiterGuard.deleteCounters(TwoFactorService.failKey(userId), TwoFactorService.lockKey(userId));
  }

  private static failKey(userId: string): string {
    return `${ATTEMPT_KEY_PREFIX}fail:${userId}`;
  }

  private static lockKey(userId: string): string {
    return `${ATTEMPT_KEY_PREFIX}lock:${userId}`;
  }

  /** Test/diagnostic helper: number of 2FA attempt counters held in this process's memory fallback. */
  static trackedAttemptCount(): number {
    return AccountIpRateLimiterGuard.memoryKeyCount(ATTEMPT_KEY_PREFIX);
  }
}
