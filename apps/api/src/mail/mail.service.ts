import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Transporter } from 'nodemailer';
import { MailContent, smtpTestEmail } from './mail.templates';

export interface OutgoingMail extends MailContent {
  to: string;
  /** Logged (outside production) when the dev outbox is used, so the link or code can be used directly. */
  devLink?: string;
  /**
   * Used instead of the subject in log lines. Set it when the subject carries a secret (the verification
   * code), so the secret never reaches logs outside the development outbox.
   */
  logLabel?: string;
}

/**
 * How outgoing mail is delivered:
 * - smtp: SMTP_HOST is set; messages are sent through nodemailer.
 * - dev-outbox: development without SMTP; each message is written to the outbox directory and logged.
 * - test-memory: Jest without MAIL_OUTBOX_DIR; messages are kept in MailService.testOutbox.
 * - unavailable: production without SMTP (the API refuses to start in this state).
 */
export type MailDeliveryMode = 'smtp' | 'dev-outbox' | 'test-memory' | 'unavailable';

/** Resolved SMTP connection settings (never logged or returned: the password is included). */
export interface SmtpSettings {
  host: string;
  port: number;
  /** Implicit TLS (port 465). Otherwise the connection starts in plain text and is upgraded with STARTTLS. */
  secure: boolean;
  /** Refuse to send when the server does not offer STARTTLS (default: on in production). */
  requireTLS: boolean;
  user?: string;
  pass?: string;
}

/** Secret-free description of the mail configuration (GET /mail/status). */
export interface MailConfigSummary {
  mode: MailDeliveryMode;
  /** True when real email is delivered (SMTP configured). */
  configured: boolean;
  production: boolean;
  provider: string | null;
  host: string | null;
  port: number | null;
  /** 'implicit' (465), 'starttls-required', 'starttls-opportunistic' or null without SMTP. */
  tls: 'implicit' | 'starttls-required' | 'starttls-opportunistic' | null;
  /** SMTP_USER with the local part masked, or null when no authentication is configured. */
  authUser: string | null;
  passwordSet: boolean;
  from: string;
  /** Development only: where the outbox files are written. */
  outboxDir: string | null;
  warnings: string[];
}

export interface MailSendResult {
  mode: MailDeliveryMode;
  messageId?: string;
  /** Final SMTP server response, e.g. "250 2.0.0 OK". */
  response?: string;
  /** Development outbox file. */
  file?: string;
}

/** Secret-free description of a failed send. */
export interface MailErrorDetails {
  code: string | null;
  responseCode: number | null;
  command: string | null;
  message: string;
  hint: string | null;
}

export interface MailTestResult {
  ok: boolean;
  mode: MailDeliveryMode;
  configured: boolean;
  recipient: string;
  durationMs: number;
  message: string;
  response?: string;
  error?: MailErrorDetails;
}

/** Default dev outbox: apps/api/.mail-outbox (git-ignored). Resolves the same from src/ (ts-node/jest) and dist/. */
export function defaultOutboxDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MAIL_OUTBOX_DIR && env.MAIL_OUTBOX_DIR.trim()) return path.resolve(env.MAIL_OUTBOX_DIR.trim());
  return path.resolve(__dirname, '..', '..', '.mail-outbox');
}

const GMAIL_HOST = /(^|\.)(gmail|googlemail)\.com$/i;

/** Well-known providers, for the status display and for error hints. */
export function smtpProviderName(host: string | null | undefined): string | null {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return null;
  if (GMAIL_HOST.test(h)) return 'Gmail / Google Workspace';
  if (h.endsWith('brevo.com') || h.endsWith('sendinblue.com')) return 'Brevo';
  if (h.endsWith('resend.com')) return 'Resend';
  if (h.includes('zoho.')) return 'Zoho Mail';
  if (h.endsWith('office365.com') || h.endsWith('outlook.com')) return 'Microsoft 365 / Outlook';
  if (h.endsWith('sendgrid.net')) return 'SendGrid';
  if (h.endsWith('mailgun.org')) return 'Mailgun';
  if (h.includes('amazonaws.com')) return 'Amazon SES';
  return null;
}

function envFlag(value: string | undefined): boolean | undefined {
  const v = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return undefined;
}

/** SMTP settings from the environment, or null when SMTP_HOST is empty. */
export function smtpSettings(env: NodeJS.ProcessEnv = process.env): SmtpSettings | null {
  const host = String(env.SMTP_HOST || '').trim();
  if (!host) return null;
  const rawPort = String(env.SMTP_PORT || '').trim();
  const port = rawPort ? Number(rawPort) : 587;
  // Port 465 always uses implicit TLS; otherwise SMTP_SECURE=true forces it (rare: most providers use 587 + STARTTLS)
  const secure = envFlag(env.SMTP_SECURE) === true || port === 465;
  const requireTLS = secure ? false : envFlag(env.SMTP_REQUIRE_TLS) ?? env.NODE_ENV === 'production';
  const user = String(env.SMTP_USER || '').trim() || undefined;
  let pass = env.SMTP_PASSWORD === undefined ? undefined : String(env.SMTP_PASSWORD).trim();
  // Google shows app passwords as four groups of four letters; the spaces are not part of the password
  if (pass && GMAIL_HOST.test(host)) pass = pass.replace(/\s+/g, '');
  return { host, port, secure, requireTLS, user, pass: pass || undefined };
}

/** The bare address of a "Name <address>" value (lower-cased), or '' when none can be found. */
export function mailboxAddress(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(raw);
  const address = angle ? angle[1] : /^[^\s<>@]+@[^\s<>@]+$/.test(raw) ? raw : '';
  return address.toLowerCase();
}

/** "ad***@gmail.com" style masking for display; non-email user names keep only their first two characters. */
export function maskUser(user: string | null | undefined): string | null {
  const u = String(user || '').trim();
  if (!u) return null;
  const at = u.indexOf('@');
  if (at > 0) return `${u.slice(0, Math.min(2, at))}***${u.slice(at)}`;
  return u.length <= 2 ? `${u}***` : `${u.slice(0, 2)}***`;
}

/** Startup check: in production SMTP_HOST and MAIL_FROM are mandatory. Returns the list of problems. */
export function mailConfigErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const errors: string[] = [];
  if (!env.SMTP_HOST || !env.SMTP_HOST.trim()) errors.push('SMTP_HOST is required in production (outgoing email).');
  if (!env.MAIL_FROM || !env.MAIL_FROM.trim()) {
    errors.push('MAIL_FROM is required in production (outgoing email).');
  } else if (!mailboxAddress(env.MAIL_FROM)) {
    errors.push('MAIL_FROM must contain an email address, e.g. "GCDIS Championship <no-reply@example.org>".');
  }
  const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : 587;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) errors.push('SMTP_PORT must be a valid port number.');
  return errors;
}

/** Removes credentials from a provider's error text (some servers echo the user name or the AUTH payload). */
export function redactSecrets(message: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = String(message || '');
  const secrets = new Set<string>();
  const settings = smtpSettings(env);
  const rawPass = env.SMTP_PASSWORD ? String(env.SMTP_PASSWORD) : '';
  for (const s of [rawPass, rawPass.trim(), settings?.pass, settings?.user]) {
    if (s && s.length >= 3) secrets.add(s);
  }
  if (settings?.user || settings?.pass) {
    const u = settings?.user || '';
    const p = settings?.pass || '';
    secrets.add(Buffer.from(`\u0000${u}\u0000${p}`).toString('base64'));
    if (u) secrets.add(Buffer.from(u).toString('base64'));
    if (p) secrets.add(Buffer.from(p).toString('base64'));
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[redacted]');
  }
  return out.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

/** Secret-free description of a nodemailer error with a practical hint for common providers. */
export function describeMailError(err: any, env: NodeJS.ProcessEnv = process.env): MailErrorDetails {
  const code = typeof err?.code === 'string' ? err.code : null;
  const responseCode = Number.isInteger(err?.responseCode) ? Number(err.responseCode) : null;
  const command = typeof err?.command === 'string' ? err.command : null;
  const message = redactSecrets(err?.message || 'Unknown error', env);
  const settings = smtpSettings(env);
  const lower = message.toLowerCase();
  const gmail = GMAIL_HOST.test(settings?.host || '');

  let hint: string | null = null;
  if (!settings) {
    hint = 'SMTP_HOST is not set. Configure SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and MAIL_FROM, then restart the API.';
  } else if (code === 'EAUTH' || responseCode === 535 || responseCode === 534 || lower.includes('invalid login')) {
    hint = gmail
      ? 'Gmail rejected the sign-in. Use a 16-character app password (Google Account > Security > 2-Step Verification > App passwords), not the normal account password, and set SMTP_USER to the full Gmail address.'
      : 'The SMTP server rejected the user name or password. Check SMTP_USER and SMTP_PASSWORD (Brevo: your SMTP login and SMTP key; Resend: user "resend" and an API key; Zoho: the mailbox address and an app-specific password).';
  } else if (lower.includes('wrong version number') || lower.includes('ssl routines') || lower.includes('starttls')) {
    hint = 'TLS mode mismatch. Use port 465 with SMTP_SECURE=true, or port 587 with SMTP_SECURE=false (STARTTLS).';
  } else if (code === 'EDNS' || lower.includes('enotfound') || lower.includes('getaddrinfo')) {
    hint = `The host name "${settings.host}" could not be resolved. Check SMTP_HOST.`;
  } else if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ESOCKET' || lower.includes('econnrefused') || lower.includes('timeout')) {
    hint = `Could not connect to ${settings.host}:${settings.port}. Check SMTP_HOST and SMTP_PORT and that the server or firewall allows outbound SMTP on this port (some hosts block 25 and 465; try 587 or 2525).`;
  } else if (code === 'EENVELOPE' || (responseCode !== null && responseCode >= 550 && responseCode <= 554)) {
    hint = 'The server refused the sender or recipient. Make sure the MAIL_FROM address (or its domain) is verified with your email provider.';
  }
  return { code, responseCode, command, message, hint };
}

/**
 * Outgoing email. With SMTP_HOST set, mail is sent through nodemailer (works with any standard
 * provider: Gmail app password on 587 STARTTLS, Brevo, Resend, Zoho, Microsoft 365, SES, ...).
 * Without it (development only), each message is written to the outbox directory and the link is
 * logged. Under Jest, messages are kept in memory (MailService.testOutbox) unless MAIL_OUTBOX_DIR is set.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;
  private transporterKey = '';

  /** Messages captured under NODE_ENV=test (newest last). */
  static testOutbox: OutgoingMail[] = [];

  onModuleInit(): void {
    const mode = this.deliveryMode();
    if (mode === 'dev-outbox') {
      this.logger.warn(
        `SMTP_HOST is not set: emails (verification, password reset) are NOT delivered. They are written to ${defaultOutboxDir()} and the links are logged here. Set SMTP_* and MAIL_FROM in .env to send real email.`
      );
    } else if (mode === 'smtp') {
      const s = smtpSettings()!;
      this.logger.log(`Outgoing email via SMTP ${s.host}:${s.port} (${s.secure ? 'implicit TLS' : 'STARTTLS'}).`);
    }
  }

  isSmtpConfigured(): boolean {
    return smtpSettings() !== null;
  }

  deliveryMode(): MailDeliveryMode {
    if (this.isSmtpConfigured()) return 'smtp';
    if (process.env.NODE_ENV === 'production') return 'unavailable';
    if (process.env.NODE_ENV === 'test' && !process.env.MAIL_OUTBOX_DIR) return 'test-memory';
    return 'dev-outbox';
  }

  private fromAddress(): string {
    return (process.env.MAIL_FROM && process.env.MAIL_FROM.trim()) || 'GCDIS Championship <no-reply@localhost>';
  }

  /** Secret-free configuration summary for the staff console. */
  describeConfig(): MailConfigSummary {
    const mode = this.deliveryMode();
    const settings = smtpSettings();
    const production = process.env.NODE_ENV === 'production';
    const from = this.fromAddress();
    const warnings: string[] = [];
    if (settings) {
      if (settings.port === 587 && envFlag(process.env.SMTP_SECURE) === true) {
        warnings.push('SMTP_SECURE=true with port 587 usually fails: port 587 uses STARTTLS (set SMTP_SECURE=false), port 465 uses implicit TLS.');
      }
      if (settings.user && !settings.pass) warnings.push('SMTP_USER is set but SMTP_PASSWORD is empty.');
      if (!settings.user) warnings.push('SMTP_USER is empty: no authentication will be attempted (most providers require it).');
      if (!mailboxAddress(process.env.MAIL_FROM)) warnings.push('MAIL_FROM is not set: a placeholder sender address is used.');
      if (GMAIL_HOST.test(settings.host) && settings.user && mailboxAddress(from) && mailboxAddress(from) !== settings.user.toLowerCase()) {
        warnings.push('Gmail sends from the signed-in account: MAIL_FROM differs from SMTP_USER and will be rewritten unless it is a verified "Send mail as" alias.');
      }
    } else if (!production) {
      warnings.push('SMTP is not configured: emails are written to the development outbox and are never delivered to real inboxes.');
    }
    return {
      mode,
      configured: mode === 'smtp',
      production,
      provider: smtpProviderName(settings?.host),
      host: settings?.host ?? null,
      port: settings?.port ?? null,
      tls: settings ? (settings.secure ? 'implicit' : settings.requireTLS ? 'starttls-required' : 'starttls-opportunistic') : null,
      authUser: maskUser(settings?.user),
      passwordSet: Boolean(settings?.pass),
      from,
      outboxDir: mode === 'dev-outbox' ? defaultOutboxDir() : null,
      warnings
    };
  }

  private getTransporter(): Transporter {
    const settings = smtpSettings()!;
    // Rebuilt when the settings change (e.g. tests, or a configuration reload)
    const key = crypto
      .createHash('sha256')
      .update(JSON.stringify([settings.host, settings.port, settings.secure, settings.requireTLS, settings.user, settings.pass]))
      .digest('hex');
    if (!this.transporter || this.transporterKey !== key) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodemailer = require('nodemailer');
      this.transporter = nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        ...(settings.user ? { auth: { user: settings.user, pass: settings.pass || '' } } : {}),
        // Never downgrade in production: STARTTLS is required when not using implicit TLS, and
        // certificates are always verified (nodemailer default)
        requireTLS: settings.requireTLS,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000
      });
      this.transporterKey = key;
    }
    return this.transporter!;
  }

  /** Sends a message. Throws on failure; prefer sendSafe() in request flows. */
  async send(mail: OutgoingMail): Promise<MailSendResult> {
    const to = String(mail.to || '').trim();
    if (!to || /[\r\n]/.test(to)) throw new Error('Invalid recipient address');
    const subject = mail.subject.replace(/[\r\n]+/g, ' ');

    if (this.isSmtpConfigured()) {
      const info: any = await this.getTransporter().sendMail({ from: this.fromAddress(), to, subject, text: mail.text, html: mail.html });
      const rejected: unknown[] = Array.isArray(info?.rejected) ? info.rejected : [];
      if (rejected.length > 0) {
        const err: any = new Error(`The SMTP server rejected the recipient. ${String(info?.response || '')}`.trim());
        err.code = 'EENVELOPE';
        throw err;
      }
      return { mode: 'smtp', messageId: info?.messageId, response: typeof info?.response === 'string' ? info.response : undefined };
    }

    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP is not configured; email cannot be sent in production.');
    }

    if (process.env.NODE_ENV === 'test' && !process.env.MAIL_OUTBOX_DIR) {
      MailService.testOutbox.push({ ...mail, to, subject });
      return { mode: 'test-memory' };
    }

    const dir = defaultOutboxDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}_${crypto.randomBytes(4).toString('hex')}.eml`);
    const boundary = `gcdis-${crypto.randomBytes(8).toString('hex')}`;
    const eml = [
      `From: ${this.fromAddress()}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      mail.text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      mail.html,
      '',
      `--${boundary}--`,
      ''
    ].join('\n');
    await fs.promises.writeFile(file, eml, { encoding: 'utf8', flag: 'wx' });
    this.logger.log(
      `[dev outbox] "${mail.logLabel || subject}" to ${to} written to ${file}${mail.devLink ? ` | ${mail.devLink}` : ''}`
    );
    return { mode: 'dev-outbox', file };
  }

  /** Sends a message and never throws. Resolves true when the message was handed over. */
  async sendSafe(mail: OutgoingMail): Promise<boolean> {
    try {
      await this.send(mail);
      return true;
    } catch (err: any) {
      const details = describeMailError(err);
      this.logger.error(
        `Email "${mail.logLabel || mail.subject}" could not be sent: ${details.code ? `[${details.code}] ` : ''}${details.message}${details.hint ? ` | ${details.hint}` : ''}`
      );
      return false;
    }
  }

  /** Sends the console's test message and reports the outcome without exposing credentials. */
  async sendTest(to: string, requestedBy: string): Promise<MailTestResult> {
    const started = Date.now();
    const mode = this.deliveryMode();
    const configured = mode === 'smtp';
    try {
      const result = await this.send({ to, ...smtpTestEmail(requestedBy) });
      return {
        ok: true,
        mode,
        configured,
        recipient: to,
        durationMs: Date.now() - started,
        message:
          mode === 'smtp'
            ? `The SMTP server accepted the test message for ${to}. Check that inbox (and its spam folder).`
            : `SMTP is not configured. The test message was written to the development outbox (${defaultOutboxDir()}) and was not delivered to ${to}.`,
        ...(result.response ? { response: redactSecrets(result.response) } : {})
      };
    } catch (err: any) {
      const error = describeMailError(err);
      this.logger.error(`Test email could not be sent: ${error.code ? `[${error.code}] ` : ''}${error.message}`);
      return {
        ok: false,
        mode,
        configured,
        recipient: to,
        durationMs: Date.now() - started,
        message: 'The test message could not be sent.',
        error
      };
    }
  }
}
