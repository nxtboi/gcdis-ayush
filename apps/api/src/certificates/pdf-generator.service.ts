import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { decodeStoredFile, encryptFileBuffer, resolveFileEncryptionKey } from '../uploads/file-encryption';

/** Supplier GSTIN from configuration only (INVOICE_GSTIN); null when unset. Never a hard-coded value. */
export function invoiceGstin(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env.INVOICE_GSTIN || '').trim();
  return value ? value : null;
}

/** "18%" / "12.5%" from the payment's stored rate; 18% only when the row predates the gstRate column. */
export function formatGstRate(rate: number | null | undefined): string {
  const n = typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? rate : 18;
  return `${Number(n.toFixed(2))}%`;
}

/**
 * Cache file for an invoice. The payment status and the configured GSTIN are part of the key, so a
 * status change (e.g. SUCCESS to REFUNDED) or a new GSTIN never serves a stale cached PDF.
 */
export function invoiceCacheFileName(invoiceNumber: string, paymentStatus?: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe = (v: string) => String(v).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  const status = safe(String(paymentStatus || 'SUCCESS').toUpperCase());
  const gstinTag = crypto.createHash('sha256').update(invoiceGstin(env) || '').digest('hex').slice(0, 8);
  return `invoice-${safe(invoiceNumber)}-${status}-${gstinTag}.pdf`;
}

/** Fields printed on an accreditation pass. */
export interface AccreditationPassData {
  teamName: string;
  teamId: string;
  institution: string;
  memberName: string;
  memberRole: string;
  category: string;
  status: string;
  qrUrl?: string;
  /**
   * Cache identity (the team member id). When set, the rendered pass is cached in storage, encrypted at rest,
   * under passCacheFileName(); omitted, the pass is rendered on every call and never stored.
   */
  cacheId?: string;
}

const PASS_CACHE_PREFIX = 'pass-';
const safeCacheId = (v: string) => String(v).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

/**
 * Cache file for a member pass: `pass-<memberId>-<content hash>.pdf`. The hash covers every rendered field
 * (member, team, category, registration status and the signed QR URL), so any change to the member, the
 * registration status or the team data produces a new file name and the stale copy is never served.
 */
export function passCacheFileName(memberId: string, passData: AccreditationPassData): string {
  const canonical = JSON.stringify([
    passData.teamName,
    passData.teamId,
    passData.institution,
    passData.memberName,
    passData.memberRole,
    passData.category,
    passData.status,
    passData.qrUrl ?? null
  ]);
  const hash = crypto.createHash('sha256').update(`gcdis-pass-v1\0${canonical}`).digest('hex').slice(0, 32);
  return `${PASS_CACHE_PREFIX}${safeCacheId(memberId)}-${hash}.pdf`;
}

@Injectable()
export class PdfGeneratorService {
  private readonly logger = new Logger(PdfGeneratorService.name);
  // Invoice and pass PDF cache (encrypted). In production this is the writable `pdf_cache_data` volume:
  // the API container's root filesystem is read-only, so the directory must not live in the image.
  private readonly storageDir = path.resolve(process.env.PDF_CACHE_DIR || path.join(process.cwd(), 'storage'));
  /** Pass renders in progress, by cache file name: concurrent downloads of one pass share a single render. */
  private readonly passRendersInFlight = new Map<string, Promise<Buffer>>();

  constructor() {
    // Never crash the API at boot over the cache: without a writable directory PDFs are still generated,
    // only not cached (writes are already best-effort).
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
    } catch (err: any) {
      this.logger.warn(`PDF cache directory ${this.storageDir} is not writable (${err?.code || 'error'}); PDFs will not be cached.`);
    }
  }

  /**
   * Generates an official GST Tax Invoice PDF for team registration fees.
   * Generates once, stores on disk, and serves directly from storage on subsequent hits. The cache key
   * includes the payment status (and the configured GSTIN), so a refund or a tax-ID change produces a
   * new document instead of serving the stale "PAID" copy.
   */
  async generateInvoicePdf(invoiceData: {
    invoiceNumber: string;
    /** Payment status: REFUNDED invoices are marked as refunded; every other status prints as paid. */
    paymentStatus?: string;
    /** GST rate stored on the payment row (percent). */
    gstRate?: number | null;
    teamName: string;
    teamId: string;
    institution: string;
    captainName: string;
    captainEmail: string;
    category: string;
    amount: number;
    gstAmount: number;
    baseAmount: number;
    paymentRef: string;
    issuedDate: string;
  }): Promise<Buffer> {
    const filePath = path.join(this.storageDir, invoiceCacheFileName(invoiceData.invoiceNumber, invoiceData.paymentStatus));
    const gstin = invoiceGstin();
    const isRefunded = String(invoiceData.paymentStatus || '').toUpperCase() === 'REFUNDED';
    const gstRateLabel = formatGstRate(invoiceData.gstRate);

    // Check if already generated and cached on storage (async: no blocking fs calls on the request path).
    // The cache holds personal data (captain name / email), so it is encrypted at rest with the same GCE1
    // envelope as private uploads; legacy plaintext cache files are still read. A cache file that fails
    // decryption is ignored and regenerated (the cache is never authoritative).
    try {
      const cached = await fs.promises.readFile(filePath);
      return decodeStoredFile(cached, resolveFileEncryptionKey().key).plaintext;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        this.logger.warn(`Could not read cached invoice PDF: ${err?.message || err}`);
      }
    }

    return new Promise(async (resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 45, size: 'A4' });
        const buffers: Buffer[] = [];

        doc.on('data', (chunk) => buffers.push(chunk));
        doc.on('end', async () => {
          const finalBuffer = Buffer.concat(buffers);
          try {
            await fs.promises.writeFile(filePath, encryptFileBuffer(finalBuffer, resolveFileEncryptionKey().key));
          } catch (e) {
            this.logger.warn(`Could not cache PDF to storage: ${e}`);
          }
          resolve(finalBuffer);
        });
        doc.on('error', (err) => reject(err));

        // Top Accent Bar (GCDIS Green)
        doc.rect(0, 0, doc.page.width, 8).fill('#16A34A');

        // Header Section
        doc.fillColor('#111625').fontSize(22).font('Helvetica-Bold').text('GCDIS SECRETARIAT', 45, 35);
        doc.fontSize(9).font('Helvetica').fillColor('#64748B').text('Galgotias Centre for Drone Intelligence & Simulation (GCDIS), Galgotias University', 45, 62);
        doc.text('Plot No. 2, Sector 17-A, Yamuna Expressway, Greater Noida, Uttar Pradesh 203201 | Tel: 0120-4806827, 0120-4806824', 45, 74);
        // Tax identifiers come from configuration only; never print placeholder registration numbers on a tax invoice.
        const taxIds = [
          gstin ? `GSTIN: ${gstin}` : null,
          process.env.INVOICE_PAN ? `PAN: ${process.env.INVOICE_PAN}` : null,
          'Email: gcdisgalgotias@gmail.com'
        ].filter(Boolean);
        doc.text(taxIds.join(' | '), 45, 86);

        // Invoice Title & Meta (Right Aligned)
        doc.fontSize(16).font('Helvetica-Bold').fillColor('#111625').text('TAX INVOICE', 350, 35, { align: 'right', width: 200 });
        doc
          .fontSize(9)
          .font('Helvetica-Bold')
          .fillColor(isRefunded ? '#B91C1C' : '#16A34A')
          .text(isRefunded ? 'STATUS: REFUNDED' : 'STATUS: PAID (VERIFIED)', 350, 56, { align: 'right', width: 200 });
        doc.fontSize(9).font('Helvetica').fillColor('#475569').text(`Invoice #: ${invoiceData.invoiceNumber}`, 350, 70, { align: 'right', width: 200 });
        doc.text(`Date of Issue: ${invoiceData.issuedDate}`, 350, 82, { align: 'right', width: 200 });
        doc.text(`Txn Ref: ${invoiceData.paymentRef}`, 350, 94, { align: 'right', width: 200 });

        // Divider
        doc.moveTo(45, 115).lineTo(550, 115).strokeColor('#E2E8F0').lineWidth(1).stroke();

        // Billed To Section
        doc.rect(45, 125, 505, 75).fillAndStroke('#F8FAFC', '#E2E8F0');
        doc.fillColor('#64748B').fontSize(8).font('Helvetica-Bold').text('BILLED TO (ACCREDITED INSTITUTION & TEAM)', 58, 135);
        doc.fillColor('#0F172A').fontSize(11).font('Helvetica-Bold').text(`TEAM ${invoiceData.teamName} (${invoiceData.teamId})`, 58, 148);
        doc.fontSize(9).font('Helvetica').fillColor('#334155').text(`Affiliated Institution: ${invoiceData.institution}`, 58, 163);
        doc.text(`Team Captain: ${invoiceData.captainName} • Contact: ${invoiceData.captainEmail}`, 58, 176);

        // Line Items Table Header
        const tableTop = 215;
        doc.rect(45, tableTop, 505, 24).fill('#111625');
        doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
        doc.text('SL', 55, tableTop + 8);
        doc.text('ITEM DESCRIPTION & SAC CODE', 85, tableTop + 8);
        doc.text('CATEGORY', 330, tableTop + 8);
        doc.text('TAXABLE VAL', 420, tableTop + 8);
        doc.text('TOTAL (INR)', 485, tableTop + 8, { align: 'right', width: 60 });

        // Line Item Row
        const rowTop = tableTop + 24;
        doc.rect(45, rowTop, 505, 45).fillAndStroke('#FFFFFF', '#E2E8F0');
        doc.fillColor('#0F172A').fontSize(9).font('Helvetica-Bold').text('01', 55, rowTop + 10);
        doc.text('Drone Soccer Championship 2026 Registration Fee', 85, rowTop + 10);
        doc.fontSize(8).font('Helvetica').fillColor('#64748B').text('Competition entry and technical inspection fee (SAC: 998399)', 85, rowTop + 23);

        doc.fontSize(8).font('Helvetica-Bold').fillColor('#16A34A').text(invoiceData.category, 330, rowTop + 14);
        doc.fontSize(9).font('Helvetica').fillColor('#0F172A').text(`₹${invoiceData.baseAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 420, rowTop + 14);
        doc.font('Helvetica-Bold').text(`₹${invoiceData.baseAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 485, rowTop + 14, { align: 'right', width: 60 });

        // Tax Calculation Summary Table
        const summaryTop = rowTop + 65;
        doc.rect(320, summaryTop, 230, 85).fillAndStroke('#F8FAFC', '#E2E8F0');

        doc.fillColor('#475569').fontSize(9).font('Helvetica').text('Subtotal (Taxable Value):', 335, summaryTop + 12);
        doc.font('Helvetica-Bold').fillColor('#0F172A').text(`₹${invoiceData.baseAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 460, summaryTop + 12, { align: 'right', width: 80 });

        doc.font('Helvetica').fillColor('#475569').text(`Integrated GST (IGST ${gstRateLabel}):`, 335, summaryTop + 28);
        doc.font('Helvetica-Bold').fillColor('#0F172A').text(`₹${invoiceData.gstAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 460, summaryTop + 28, { align: 'right', width: 80 });

        doc.moveTo(330, summaryTop + 45).lineTo(540, summaryTop + 45).strokeColor('#CBD5E1').stroke();

        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111625').text(isRefunded ? 'Total (Refunded):' : 'Total Paid:', 335, summaryTop + 55);
        doc.fillColor(isRefunded ? '#B91C1C' : '#16A34A').fontSize(12).text(`₹${invoiceData.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 460, summaryTop + 54, { align: 'right', width: 80 });

        // QR Code Verification Seal
        const qrUrl = `https://gcdis.in/verify/invoice/${invoiceData.invoiceNumber}`;
        const qrImageBuffer = await QRCode.toBuffer(qrUrl, { margin: 1, width: 85 });
        doc.image(qrImageBuffer, 45, summaryTop + 5, { width: 75 });
        doc.fillColor('#64748B').fontSize(7).font('Helvetica').text('Scan to verify authentic', 45, summaryTop + 82);
        doc.text('digital invoice signature', 45, summaryTop + 90);

        // Declarations & Signatures
        const footerTop = 410;
        doc.rect(45, footerTop, 505, 90).fillAndStroke('#F8FAFC', '#E2E8F0');
        doc.fillColor('#0F172A').fontSize(8).font('Helvetica-Bold').text('DECLARATION AND TERMS', 58, footerTop + 10);
        doc.fontSize(7.5).font('Helvetica').fillColor('#475569');
        doc.text('1. This registration fee is reconciled against official GCDIS technical inspection and pit access allocation.', 58, footerTop + 24);
        doc.text('2. Computer-generated tax invoice issued by the Global Center for Drone Innovation & Science Secretariat.', 58, footerTop + 36);
        // The ITC line names the supplier's GSTIN, so it is printed only when one is configured
        if (gstin) {
          doc.text(`3. Input Tax Credit (ITC) is applicable subject to filing under GSTIN ${gstin}.`, 58, footerTop + 48);
        }
        if (isRefunded) {
          doc.text(`${gstin ? '4' : '3'}. This registration fee has been refunded; this invoice is retained for record purposes only.`, 58, footerTop + (gstin ? 60 : 48));
        }

        doc.fontSize(8).font('Helvetica-Bold').fillColor('#111625').text('AUTHORIZED SIGNATORY', 380, footerTop + 58, { align: 'right', width: 160 });
        doc.fontSize(7).font('Helvetica').fillColor('#64748B').text('GCDIS Finance Directorate', 380, footerTop + 70, { align: 'right', width: 160 });

        // End of doc
        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Generates a printable Team Accreditation Pass / Identity Card PDF.
   *
   * With `cacheId` (the member id) the pass is cached like invoices: stored encrypted at rest (GCE1) under a
   * file name that includes a hash of every rendered field, so a later download is served without rendering,
   * and any change to the member, registration status or team data misses the cache. Superseded cache files
   * of the same member are removed. The cache is never authoritative: an unreadable, undecryptable or
   * plaintext cache file is ignored and the pass is rendered again. Authorisation happens before this call.
   */
  async generateAccreditationPassPdf(passData: AccreditationPassData): Promise<Buffer> {
    if (!passData.cacheId) return this.renderAccreditationPassPdf(passData);

    const fileName = passCacheFileName(passData.cacheId, passData);
    const filePath = path.join(this.storageDir, fileName);
    try {
      const cached = await fs.promises.readFile(filePath);
      const decoded = decodeStoredFile(cached, resolveFileEncryptionKey().key);
      // Pass caches are always written encrypted; a plaintext file here was not written by us
      if (decoded.encrypted) return decoded.plaintext;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        this.logger.warn(`Could not read cached pass PDF: ${err?.message || err}`);
      }
    }

    const inFlight = this.passRendersInFlight.get(fileName);
    if (inFlight) return inFlight;
    const render = (async () => {
      const pdf = await this.renderAccreditationPassPdf(passData);
      await this.storePassCache(passData.cacheId as string, fileName, pdf);
      return pdf;
    })().finally(() => this.passRendersInFlight.delete(fileName));
    this.passRendersInFlight.set(fileName, render);
    return render;
  }

  /** Writes the encrypted pass cache (atomically) and removes superseded cache files of the member. Never throws. */
  private async storePassCache(memberId: string, fileName: string, pdf: Buffer): Promise<void> {
    const filePath = path.join(this.storageDir, fileName);
    const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, encryptFileBuffer(pdf, resolveFileEncryptionKey().key));
      await fs.promises.rename(tmpPath, filePath);
    } catch (e: any) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
      this.logger.warn(`Could not cache pass PDF to storage: ${e?.message || e}`);
      return;
    }
    const memberPrefix = `${PASS_CACHE_PREFIX}${safeCacheId(memberId)}-`;
    try {
      const stale = (await fs.promises.readdir(this.storageDir)).filter(
        (name) => name.startsWith(memberPrefix) && name.endsWith('.pdf') && name !== fileName
      );
      await Promise.all(stale.map((name) => fs.promises.rm(path.join(this.storageDir, name), { force: true })));
    } catch (e: any) {
      this.logger.warn(`Could not prune superseded pass PDFs: ${e?.message || e}`);
    }
  }

  /** Renders the pass PDF (no caching). */
  private async renderAccreditationPassPdf(passData: AccreditationPassData): Promise<Buffer> {
    return new Promise(async (resolve, reject) => {
      try {
        // Size: A5 Portrait (420 x 595 pt)
        const doc = new PDFDocument({ margin: 30, size: 'A5' });
        const buffers: Buffer[] = [];

        doc.on('data', (chunk) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', (err) => reject(err));

        const cardWidth = doc.page.width - 60;

        // Header Banner (Dark Navy)
        doc.rect(30, 30, cardWidth, 80).fill('#111625');
        doc.fillColor('#22C55E').fontSize(11).font('Helvetica-Bold').text('GCDIS OFFICIAL ACCREDITATION', 45, 45);
        doc.fillColor('#FFFFFF').fontSize(16).text('DRONE SOCCER 2026', 45, 60);
        doc.fillColor('#94A3B8').fontSize(8).font('Helvetica').text('Drone Soccer Championship 2026 • Arena Pass', 45, 82);

        // Main Body Box
        doc.rect(30, 110, cardWidth, 380).fillAndStroke('#FFFFFF', '#CBD5E1');

        // Member Avatar Placeholder
        doc.rect(45, 130, 65, 75).fillAndStroke('#F1F5F9', '#94A3B8');
        doc.fillColor('#64748B').fontSize(18).font('Helvetica-Bold').text(
          passData.memberName.substring(0, 2).toUpperCase(),
          45,
          155,
          { align: 'center', width: 65 }
        );

        // Member Details
        doc.fillColor('#0F172A').fontSize(14).font('Helvetica-Bold').text(passData.memberName, 125, 135);
        doc.fillColor('#16A34A').fontSize(10).text(passData.memberRole.toUpperCase(), 125, 153);
        doc.fillColor('#475569').fontSize(9).font('Helvetica').text(passData.institution, 125, 168);
        doc.fontSize(8).text(`Category: ${passData.category}`, 125, 183);

        // Divider
        doc.moveTo(45, 220).lineTo(doc.page.width - 45, 220).strokeColor('#E2E8F0').stroke();

        // Team & Security Badge
        doc.rect(45, 235, cardWidth - 30, 50).fill('#F8FAFC');
        doc.fillColor('#64748B').fontSize(8).font('Helvetica-Bold').text('ACCREDITED TEAM', 55, 243);
        doc.fillColor('#0F172A').fontSize(12).text(passData.teamName, 55, 255);
        doc.fillColor('#16A34A').fontSize(9).font('Helvetica-Bold').text(`TEAM ID: ${passData.teamId}`, 55, 270);

        doc.fillColor('#64748B').fontSize(8).text('SCRUTINEERING STATUS', 240, 243);
        doc.fillColor('#16A34A').fontSize(11).font('Helvetica-Bold').text(passData.status, 240, 255);

        // QR Code in Center
        const qrUrl = passData.qrUrl || `https://gcdis.in/verify/id/${passData.teamId}-${passData.memberName.replace(/\s+/g, '')}`;
        const qrImageBuffer = await QRCode.toBuffer(qrUrl, { margin: 1, width: 140 });
        doc.image(qrImageBuffer, (doc.page.width - 140) / 2, 300, { width: 140 });

        doc.fillColor('#64748B').fontSize(8).font('Helvetica').text('Scan with Scrutineer Device at Pitch Access Gates', 45, 450, { align: 'center', width: cardWidth });

        // Security Notice Footer
        doc.rect(30, 490, cardWidth, 35).fill('#111625');
        doc.fillColor('#FFFFFF').fontSize(7.5).font('Helvetica').text(
          'Valid for Pitch Access, Pilot Line, and Technical Pit Areas. Non-transferable.',
          40,
          502,
          { align: 'center', width: cardWidth - 20 }
        );

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}
