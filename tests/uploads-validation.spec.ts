import { validateUploadedBuffer } from '../apps/api/src/common/utils/upload-validator.util';
import { BadRequestException } from '@nestjs/common';

describe('Module: Direct Upload Validation & Antivirus Magic-Byte Inspection', () => {
  test('Valid PDF buffer passes validation and returns sha256 checksum', () => {
    const validPdfBuffer = Buffer.from('%PDF-1.4\n%test\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
    const result = validateUploadedBuffer(validPdfBuffer, 'Institutional_NOC.pdf');

    expect(result.mimeType).toBe('application/pdf');
    expect(result.sizeBytes).toBe(validPdfBuffer.length);
    expect(result.sha256).toBeDefined();
    expect(result.fileName).toBe('Institutional_NOC.pdf');
  });

  test('Valid PNG buffer passes validation with image/png MIME', () => {
    const validPngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const result = validateUploadedBuffer(validPngBuffer, 'team_logo.png');

    expect(result.mimeType).toBe('image/png');
    expect(result.fileName).toBe('team_logo.png');
  });

  test('Valid JPEG buffer passes validation with image/jpeg MIME', () => {
    const validJpgBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const result = validateUploadedBuffer(validJpgBuffer, 'drone_cage.jpg');

    expect(result.mimeType).toBe('image/jpeg');
  });

  test('Disguised binary (e.g. .exe or script named .pdf) is rejected due to magic-byte inspection failure', () => {
    const fakeBuffer = Buffer.from('MZ\x90\x00\x03\x00\x00\x00ThisIsAnExecutableFileDisguisedAsPdf');
    expect(() => {
      validateUploadedBuffer(fakeBuffer, 'malicious_file.pdf');
    }).toThrow(BadRequestException);
  });

  test('Antivirus detection rejects files containing malware/EICAR signatures', () => {
    const maliciousBuffer = Buffer.from(
      '%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n%%EOF'
    );
    expect(() => {
      validateUploadedBuffer(maliciousBuffer, 'infected_document.pdf');
    }).toThrow('Security Alert: Malicious file signature detected. Upload rejected.');
  });

  test('Directory traversal characters in filenames are sanitized to prevent path exploits', () => {
    const validPdfBuffer = Buffer.from('%PDF-1.4\nvalid pdf data\n%%EOF');
    const result = validateUploadedBuffer(validPdfBuffer, '../../../etc/passwd.pdf');

    expect(result.fileName).not.toContain('../');
    expect(result.fileName).not.toContain('/');
  });

  test('Files exceeding maximum allowed size are rejected with descriptive error', () => {
    const oversizedBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB
    // Set PDF header
    oversizedBuffer.write('%PDF-1.4', 0);

    expect(() => {
      validateUploadedBuffer(oversizedBuffer, 'huge_file.pdf', { maxSizeBytes: 10 * 1024 * 1024 });
    }).toThrow('exceeds maximum allowed limit');
  });
});
