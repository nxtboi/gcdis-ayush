import { Injectable, Logger, Optional } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { securityAlertEmail } from '../mail/mail.templates';

export type SecurityAlertEvent =
  | 'ACCOUNT_LOCKOUT'
  | 'REFRESH_TOKEN_REPLAY'
  | 'STEP_UP_LOCKED'
  | 'TWO_FACTOR_LOCKED'
  | 'ADMIN_IP_DENIED'
  | 'STAFF_NEW_DEVICE_LOGIN'
  | 'STAFF_SESSION_LIMIT_REACHED'
  | 'TWO_FACTOR_RESET'
  | 'UPLOAD_MALWARE_BLOCKED'
  | 'UPLOAD_DECRYPTION_FAILED'
  | 'PAYMENT_WEBHOOK_SIGNATURE_FAILURES'
  | 'SUPER_ADMIN_ROLE_GRANTED'
  | 'SUPER_ADMIN_ROLE_REVOKED'
  | 'AUDIT_CHAIN_BROKEN'
  | 'STAFF_ACCOUNT_DEACTIVATED'
  | 'PAYMENT_REQUIRES_MANUAL_REFUND';

const EVENT_TITLES: Readonly<Record<SecurityAlertEvent, string>> = {
  ACCOUNT_LOCKOUT: 'Account temporarily locked after repeated failed sign-in attempts',
  REFRESH_TOKEN_REPLAY: 'Refresh-token replay detected; the session family was revoked',
  STEP_UP_LOCKED: 'Step-up re-authentication locked after repeated failures',
  TWO_FACTOR_LOCKED: 'Two-factor sign-in locked after repeated failures',
  ADMIN_IP_DENIED: 'Staff access denied from a network outside the allow-list',
  STAFF_NEW_DEVICE_LOGIN: 'Staff sign-in from a network (/24) or browser not seen on the account in the last 30 days',
  STAFF_SESSION_LIMIT_REACHED: 'Staff concurrent session limit reached; the oldest session was signed out',
  TWO_FACTOR_RESET: 'Two-factor authentication was reset or disabled',
  UPLOAD_MALWARE_BLOCKED: 'An uploaded file was blocked by the malware scan',
  UPLOAD_DECRYPTION_FAILED: 'An encrypted stored file failed authentication (possible tampering or wrong key)',
  PAYMENT_WEBHOOK_SIGNATURE_FAILURES: 'Repeated payment webhook signature failures',
  SUPER_ADMIN_ROLE_GRANTED: 'A staff account was granted the Super Administrator role',
  SUPER_ADMIN_ROLE_REVOKED: 'The Super Administrator role was removed from a staff account',
  AUDIT_CHAIN_BROKEN: 'The audit log hash chain failed verification (possible tampering)',
  STAFF_ACCOUNT_DEACTIVATED: 'A staff account was deactivated',
  PAYMENT_REQUIRES_MANUAL_REFUND: 'A payment was captured that cannot be applied and must be refunded manually'
};

/** The same event + subject is delivered at most once per window. */
export const ALERT_DEDUP_WINDOW_MS = 10 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 3000;
const MAX_DEDUP_ENTRIES = 5000;
const WEBHOOK_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const WEBHOOK_FAILURE_THRESHOLD = 3;

/** Production requires an https webhook; http is accepted outside production (local testing). */
export function securityWebhookUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.SECURITY_ALERT_WEBHOOK_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return url.toString();
    if (url.protocol === 'http:' && env.NODE_ENV !== 'production') return url.toString();
  } catch {
    // fall through
  }
  return null;
}

/** Startup check used by main.ts. */
export function securityAlertConfigErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.SECURITY_ALERT_WEBHOOK_URL || '').trim();
  if (raw && env.NODE_ENV === 'production' && !securityWebhookUrl(env)) {
    return ['SECURITY_ALERT_WEBHOOK_URL must be an https URL in production.'];
  }
  return [];
}

/**
 * Security alerting: a Slack/Discord compatible JSON POST ({ text }, plus Discord's "content") to
 * SECURITY_ALERT_WEBHOOK_URL and/or an email to SECURITY_ALERT_EMAIL. Deduplicated per event+subject
 * (10 minutes), fire-and-forget, never throws. Every alert is also written to the application log.
 */
@Injectable()
export class SecurityAlertService {
  private readonly logger = new Logger('SecurityAlert');
  private static lastSent = new Map<string, number>();
  private static webhookFailures: number[] = [];

  constructor(@Optional() private readonly mail?: MailService) {}

  /** Test helper. */
  static reset(): void {
    SecurityAlertService.lastSent.clear();
    SecurityAlertService.webhookFailures = [];
  }

  /**
   * Raises an alert. Resolves once delivery was attempted (callers normally do not await it).
   * Returns false when the alert was suppressed as a duplicate.
   */
  async alert(event: SecurityAlertEvent, subject: string, details: Record<string, unknown> = {}): Promise<boolean> {
    try {
      const key = `${event}|${subject}`;
      const now = Date.now();
      const last = SecurityAlertService.lastSent.get(key);
      if (last !== undefined && now - last < ALERT_DEDUP_WINDOW_MS) return false;
      this.remember(key, now);

      const title = EVENT_TITLES[event] || event;
      const detailLines = Object.entries({ subject, ...details })
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join('\n');
      const environment = process.env.NODE_ENV || 'development';
      const text = `[GCDIS ${environment}] Security alert: ${title}\n${detailLines}\nTime: ${new Date(now).toISOString()}`;

      this.logger.warn(JSON.stringify({ securityAlert: event, subject, ...details }));

      await Promise.all([this.postWebhook(text), this.sendEmail(title, `${detailLines}\nTime: ${new Date(now).toISOString()}`)]);
      return true;
    } catch (err: any) {
      this.logger.error(`Security alert could not be processed: ${err?.message || 'unknown error'}`);
      return false;
    }
  }

  /**
   * Counts payment webhook signature failures in a sliding 10-minute window and raises
   * PAYMENT_WEBHOOK_SIGNATURE_FAILURES at three or more.
   */
  recordWebhookSignatureFailure(ipAddress?: string): void {
    try {
      const now = Date.now();
      const recent = SecurityAlertService.webhookFailures.filter((t) => now - t < WEBHOOK_FAILURE_WINDOW_MS);
      recent.push(now);
      SecurityAlertService.webhookFailures = recent.slice(-100);
      if (recent.length >= WEBHOOK_FAILURE_THRESHOLD) {
        void this.alert('PAYMENT_WEBHOOK_SIGNATURE_FAILURES', 'razorpay-webhook', {
          failuresInLast10Minutes: recent.length,
          lastIpAddress: ipAddress
        });
      }
    } catch {
      // never throws
    }
  }

  private remember(key: string, now: number): void {
    const store = SecurityAlertService.lastSent;
    if (store.size >= MAX_DEDUP_ENTRIES) {
      for (const [k, t] of store) {
        if (now - t >= ALERT_DEDUP_WINDOW_MS) store.delete(k);
      }
      if (store.size >= MAX_DEDUP_ENTRIES) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
    }
    store.set(key, now);
  }

  private async postWebhook(text: string): Promise<void> {
    const url = securityWebhookUrl();
    if (!url) return;
    const fetchImpl = (globalThis as any).fetch;
    if (typeof fetchImpl !== 'function') return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // "text" for Slack-compatible receivers, "content" for Discord
        body: JSON.stringify({ text, content: text.slice(0, 1900) }),
        signal: controller.signal,
        redirect: 'error'
      });
      if (!res?.ok) this.logger.error(`Security alert webhook answered HTTP ${res?.status}.`);
    } catch (err: any) {
      this.logger.error(`Security alert webhook failed: ${err?.name === 'AbortError' ? 'timeout' : err?.message || 'error'}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendEmail(title: string, details: string): Promise<void> {
    const to = (process.env.SECURITY_ALERT_EMAIL || '').trim();
    if (!to || !this.mail) return;
    const content = securityAlertEmail(title, details);
    await this.mail.sendSafe({ to, ...content });
  }
}
