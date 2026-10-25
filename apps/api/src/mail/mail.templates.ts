/**
 * Formal plain-text and simple HTML email templates (GCDIS, Galgotias University).
 * No external images, scripts or tracking; every interpolated value is HTML-escaped.
 */

export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

const ORGANISATION = 'GCDIS Championship Secretariat';
const INSTITUTION = 'Galgotias University, Greater Noida';

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function salutation(name?: string | null): string {
  const clean = typeof name === 'string' ? name.replace(/[\r\n]+/g, ' ').trim().slice(0, 120) : '';
  return clean ? `Dear ${clean},` : 'Dear Participant,';
}

const TEXT_FOOTER = [
  '',
  'Yours sincerely,',
  ORGANISATION,
  INSTITUTION,
  '',
  'This is an automated message. Please do not reply to this email.'
].join('\n');

function htmlLayout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Georgia,'Times New Roman',serif;color:#1f2933;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f7;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #d9dde3;">
<tr><td style="background:#0b2545;padding:20px 28px;color:#ffffff;">
<div style="font-size:20px;font-weight:bold;letter-spacing:0.5px;">GCDIS</div>
<div style="font-size:13px;opacity:0.85;">${escapeHtml(INSTITUTION)}</div>
</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6;">
${bodyHtml}
<p style="margin:28px 0 0 0;">Yours sincerely,<br>${escapeHtml(ORGANISATION)}<br>${escapeHtml(INSTITUTION)}</p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e4e7eb;font-size:12px;color:#616e7c;">
This is an automated message. Please do not reply to this email.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function button(link: string, label: string): string {
  const href = escapeHtml(link);
  return `<p style="margin:24px 0;"><a href="${href}" style="display:inline-block;background:#0b2545;color:#ffffff;text-decoration:none;padding:12px 22px;font-family:Arial,Helvetica,sans-serif;font-size:14px;">${escapeHtml(label)}</a></p>
<p style="font-size:13px;color:#52606d;">If the button does not work, copy the following address into your browser:<br><span style="word-break:break-all;">${href}</span></p>`;
}

export function verificationEmail(name: string | null | undefined, link: string): MailContent {
  const subject = 'GCDIS: Please confirm your email address';
  const text = [
    salutation(name),
    '',
    'Thank you for registering a team captain account with the GCDIS Championship portal.',
    'To confirm your email address, please open the following link:',
    '',
    link,
    '',
    'This link is valid for 24 hours and may be used only once. Until your email address is confirmed,',
    'you may sign in and prepare your team, but you will not be able to submit a registration or make a payment.',
    '',
    'If you did not create this account, you may disregard this message.',
    TEXT_FOOTER
  ].join('\n');
  const html = htmlLayout(
    subject,
    `<p>${escapeHtml(salutation(name))}</p>
<p>Thank you for registering a team captain account with the GCDIS Championship portal. To confirm your email address, please select the button below.</p>
${button(link, 'Confirm email address')}
<p>This link is valid for 24 hours and may be used only once. Until your email address is confirmed, you may sign in and prepare your team, but you will not be able to submit a registration or make a payment.</p>
<p>If you did not create this account, you may disregard this message.</p>`
  );
  return { subject, text, html };
}

export function passwordResetEmail(name: string | null | undefined, link: string): MailContent {
  const subject = 'GCDIS: Password reset request';
  const text = [
    salutation(name),
    '',
    'We received a request to reset the password of your GCDIS Championship portal account.',
    'To choose a new password, please open the following link:',
    '',
    link,
    '',
    'This link is valid for 30 minutes and may be used only once. Resetting your password will sign you out',
    'of every device.',
    '',
    'If you did not request a password reset, you may disregard this message; your password will remain unchanged.',
    TEXT_FOOTER
  ].join('\n');
  const html = htmlLayout(
    subject,
    `<p>${escapeHtml(salutation(name))}</p>
<p>We received a request to reset the password of your GCDIS Championship portal account. To choose a new password, please select the button below.</p>
${button(link, 'Reset password')}
<p>This link is valid for 30 minutes and may be used only once. Resetting your password will sign you out of every device.</p>
<p>If you did not request a password reset, you may disregard this message; your password will remain unchanged.</p>`
  );
  return { subject, text, html };
}

export function passwordChangedNotice(name: string | null | undefined): MailContent {
  const subject = 'GCDIS: Your password has been changed';
  const text = [
    salutation(name),
    '',
    'This is to confirm that the password of your GCDIS Championship portal account has been reset.',
    'For your security, every active session has been signed out.',
    '',
    'If you did not make this change, please contact the GCDIS Secretariat immediately.',
    TEXT_FOOTER
  ].join('\n');
  const html = htmlLayout(
    subject,
    `<p>${escapeHtml(salutation(name))}</p>
<p>This is to confirm that the password of your GCDIS Championship portal account has been reset. For your security, every active session has been signed out.</p>
<p>If you did not make this change, please contact the GCDIS Secretariat immediately.</p>`
  );
  return { subject, text, html };
}

export function securityAlertEmail(summary: string, details: string): MailContent {
  const subject = `GCDIS security alert: ${summary.replace(/[\r\n]+/g, ' ').slice(0, 120)}`;
  const text = [
    'A security event was recorded by the GCDIS platform.',
    '',
    `Event: ${summary}`,
    '',
    details,
    '',
    'Please review the audit log in the staff console.',
    TEXT_FOOTER
  ].join('\n');
  const html = htmlLayout(
    subject,
    `<p>A security event was recorded by the GCDIS platform.</p>
<p><strong>Event:</strong> ${escapeHtml(summary)}</p>
<pre style="white-space:pre-wrap;font-family:Consolas,Menlo,monospace;font-size:13px;background:#f4f5f7;padding:12px;border:1px solid #e4e7eb;">${escapeHtml(details)}</pre>
<p>Please review the audit log in the staff console.</p>`
  );
  return { subject, text, html };
}

/** Sent by a Super Administrator from the staff console to confirm that outgoing email works. */
export function smtpTestEmail(requestedBy: string, sentAt: Date = new Date()): MailContent {
  const subject = 'GCDIS: Outgoing email test';
  const who = String(requestedBy || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 254) || 'a staff member';
  const when = sentAt.toUTCString();
  const text = [
    'This message confirms that the GCDIS platform can send email.',
    '',
    `Requested by: ${who}`,
    `Sent at: ${when}`,
    '',
    'No action is required. Verification and password reset emails will be delivered through the same server.',
    TEXT_FOOTER
  ].join('\n');
  const html = htmlLayout(
    subject,
    `<p>This message confirms that the GCDIS platform can send email.</p>
<p><strong>Requested by:</strong> ${escapeHtml(who)}<br><strong>Sent at:</strong> ${escapeHtml(when)}</p>
<p>No action is required. Verification and password reset emails will be delivered through the same server.</p>`
  );
  return { subject, text, html };
}

/** Email verification by code (valid for 15 minutes). The subject carries the code so it shows in previews. */
export function verificationCodeEmail(name: string | null | undefined, code: string, validMinutes = 15): MailContent {
  const clean = String(code).replace(/\D/g, '').slice(0, 6);
  const subject = `Your GCDIS verification code: ${clean}`;
  const text = [
    salutation(name),
    '',
    'Thank you for registering a team captain account with the GCDIS Championship portal.',
    'To confirm your email address, please enter the following verification code in the Team Portal:',
    '',
    `    ${clean}`,
    '',
    `This code expires in ${validMinutes} minutes and may be used only once. Until your email address is confirmed,`,
    'you may sign in and prepare your team, but you will not be able to submit a registration or make a payment.',
    '',
    'Never share this code with anyone who contacts you unexpectedly. If you did not create this account, you may disregard this message.',
    TEXT_FOOTER
  ].join('\n');
  const html = htmlLayout(
    subject,
    `<p>${escapeHtml(salutation(name))}</p>
<p>Thank you for registering a team captain account with the GCDIS Championship portal. To confirm your email address, please enter the following verification code in the Team Portal:</p>
<p style="margin:24px 0;font-family:Consolas,Menlo,monospace;font-size:32px;letter-spacing:8px;font-weight:bold;color:#0b2545;">${escapeHtml(clean)}</p>
<p>This code expires in ${validMinutes} minutes and may be used only once. Until your email address is confirmed, you may sign in and prepare your team, but you will not be able to submit a registration or make a payment.</p>
<p style="font-size:13px;color:#52606d;">Never share this code with anyone who contacts you unexpectedly. If you did not create this account, you may disregard this message.</p>`
  );
  return { subject, text, html };
}

/**
 * Sent to a staff member when their account signs in to the staff console from a network or browser not seen
 * on the account in the last 30 days. Every value is HTML-escaped and stripped of line breaks.
 */
export function staffNewSignInNotice(
  name: string | null | undefined,
  details: { time: Date; ipAddress?: string | null; browser?: string | null }
): MailContent {
  const oneLine = (v: unknown, max = 200) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
  const subject = 'GCDIS: New sign-in to your staff account';
  const when = `${details.time.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
  const ip = oneLine(details.ipAddress, 64) || 'Unknown';
  const browser = oneLine(details.browser, 120) || 'Unknown';
  const warning =
    "If this wasn't you, change your password immediately and contact the Super Administrator so that your sessions can be revoked.";
  const greeting = salutation(name).replace('Dear Participant,', 'Dear Staff Member,');
  const text = [
    greeting,
    '',
    'Your GCDIS staff console account was signed in to from a new device or network.',
    '',
    `Time: ${when}`,
    `IP address: ${ip}`,
    `Browser: ${browser}`,
    '',
    'If this was you, no action is needed.',
    warning,
    TEXT_FOOTER
  ].join('\n');
  const html = htmlLayout(
    subject,
    `<p>${escapeHtml(greeting)}</p>
<p>Your GCDIS staff console account was signed in to from a new device or network.</p>
<table role="presentation" cellspacing="0" cellpadding="0" style="margin:16px 0;font-size:14px;">
<tr><td style="padding:2px 12px 2px 0;"><strong>Time</strong></td><td>${escapeHtml(when)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;"><strong>IP address</strong></td><td>${escapeHtml(ip)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;"><strong>Browser</strong></td><td>${escapeHtml(browser)}</td></tr>
</table>
<p>If this was you, no action is needed.</p>
<p><strong>${escapeHtml(warning)}</strong></p>`
  );
  return { subject, text, html };
}
