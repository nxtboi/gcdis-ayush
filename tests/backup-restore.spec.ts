import * as crypto from 'crypto';
import { StructuredLoggerService } from '../apps/api/src/common/logger/structured-logger.service';

describe('Module: Encrypted Backups, Restore Validation & Observability Alerts', () => {
  const DUMMY_KEY = 'super_secure_backup_encryption_passphrase_32_bytes!';
  const SAMPLE_DUMP_DATA = Buffer.from(
    'PGDMP\x00\x01\x00\x00\x01PostgreSQL Dump File Simulation with Users, Registrations and Audit Logs'
  );

  test('1. Backup Encryption & Decryption roundtrip with AES-256-CBC and PBKDF2', () => {
    // Simulate backup.sh encryption
    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(DUMMY_KEY, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(SAMPLE_DUMP_DATA), cipher.final()]);

    // Encrypted payload should be different from plaintext
    expect(encrypted.equals(SAMPLE_DUMP_DATA)).toBe(false);

    // Simulate restore.sh decryption
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    expect(decrypted.toString()).toBe(SAMPLE_DUMP_DATA.toString());
  });

  test('2. Decryption fails cleanly with incorrect passphrase', () => {
    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(DUMMY_KEY, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(SAMPLE_DUMP_DATA), cipher.final()]);

    const WRONG_KEY = 'wrong_password_attempt_should_fail_verification';
    const wrongKey = crypto.pbkdf2Sync(WRONG_KEY, salt, 100000, 32, 'sha256');

    const decipher = crypto.createDecipheriv('aes-256-cbc', wrongKey, iv);
    expect(() => {
      Buffer.concat([decipher.update(encrypted), decipher.final()]);
    }).toThrow();
  });

  test('3. StructuredLoggerService emits structured JSON with PAYMENT_FAILURE_ALERT', () => {
    const logger = new StructuredLoggerService();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    logger.alertFailedPayment({
      orderId: 'order_test_999',
      paymentId: 'pay_failed_123',
      amount: 11800,
      reason: 'Signature mismatch / Razorpay 502 Bad Gateway',
      actorId: 'usr-captain-1',
      ipAddress: '192.168.1.100'
    });

    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedOutput = consoleErrorSpy.mock.calls[0][0];
    const parsed = JSON.parse(loggedOutput);

    expect(parsed.level).toBe('error');
    expect(parsed.alertType).toBe('PAYMENT_FAILURE_ALERT');
    expect(parsed.orderId).toBe('order_test_999');
    expect(parsed.amount).toBe(11800);
    expect(parsed.ipAddress).toBe('192.168.1.100');
    expect(parsed.timestamp).toBeDefined();

    consoleErrorSpy.mockRestore();
  });

  test('4. StructuredLoggerService emits structured JSON with FAILED_LOGIN_ALERT', () => {
    const logger = new StructuredLoggerService();
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    logger.alertFailedLogin({
      email: 'attacker@suspicious.org',
      ipAddress: '203.0.113.42',
      failedAttempts: 5,
      reason: 'Consecutive invalid passwords exceeded lockout threshold'
    });

    expect(consoleWarnSpy).toHaveBeenCalled();
    const loggedOutput = consoleWarnSpy.mock.calls[0][0];
    const parsed = JSON.parse(loggedOutput);

    expect(parsed.level).toBe('warn');
    expect(parsed.alertType).toBe('FAILED_LOGIN_ALERT');
    expect(parsed.email).toBe('attacker@suspicious.org');
    expect(parsed.failedAttempts).toBe(5);
    expect(parsed.ipAddress).toBe('203.0.113.42');

    consoleWarnSpy.mockRestore();
  });
});
