import * as fs from 'fs';
import * as path from 'path';

/**
 * Security round 3 (web and console): per-request nonce CSP from middleware, portal email verification and
 * password reset pages, and the password policy UI.
 */
const rootDir = path.join(__dirname, '..');
const web = (...p: string[]) => path.join(rootDir, 'apps', 'web', ...p);
const admin = (...p: string[]) => path.join(rootDir, 'apps', 'admin', ...p);
const read = (file: string) => fs.readFileSync(file, 'utf-8');

type CspModule = { buildContentSecurityPolicy: (nonce: string) => string; createNonce: () => string };

/** Loads a csp.ts module with the given NODE_ENV / API URL (both are read when the module loads). */
function loadCsp(file: string, env: { NODE_ENV: string; NEXT_PUBLIC_API_URL?: string }): CspModule {
  const saved = { NODE_ENV: process.env.NODE_ENV, NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL };
  const mutableEnv = process.env as Record<string, string | undefined>;
  mutableEnv.NODE_ENV = env.NODE_ENV;
  if (env.NEXT_PUBLIC_API_URL) mutableEnv.NEXT_PUBLIC_API_URL = env.NEXT_PUBLIC_API_URL;
  else delete mutableEnv.NEXT_PUBLIC_API_URL;
  let mod: CspModule | undefined;
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require(file) as CspModule;
    });
  } finally {
    mutableEnv.NODE_ENV = saved.NODE_ENV;
    if (saved.NEXT_PUBLIC_API_URL === undefined) delete mutableEnv.NEXT_PUBLIC_API_URL;
    else mutableEnv.NEXT_PUBLIC_API_URL = saved.NEXT_PUBLIC_API_URL;
  }
  return mod as CspModule;
}

function directive(policy: string, name: string): string {
  return policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
}

describe('Security round 3: web and console', () => {
  describe('1. Nonce-based Content-Security-Policy', () => {
    const PROD = { NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'https://api.gcdis.in/api' };
    const DEV = { NODE_ENV: 'development' };

    test('public site production policy: nonce + strict-dynamic, no unsafe-inline / unsafe-eval for scripts', () => {
      const csp = loadCsp(web('src', 'lib', 'csp.ts'), PROD);
      const nonce = csp.createNonce();
      expect(nonce).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
      expect(csp.createNonce()).not.toBe(nonce);
      const policy = csp.buildContentSecurityPolicy(nonce);
      const scriptSrc = directive(policy, 'script-src');
      expect(scriptSrc).toContain(`'nonce-${nonce}'`);
      expect(scriptSrc).toContain("'strict-dynamic'");
      expect(scriptSrc).toContain('https://checkout.razorpay.com');
      expect(scriptSrc).toContain('https://accounts.google.com/gsi/client');
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(scriptSrc).not.toContain("'unsafe-eval'");
      // Sources kept from the previous static policy
      expect(directive(policy, 'connect-src')).toContain('https://api.gcdis.in');
      expect(directive(policy, 'connect-src')).toContain('wss://api.gcdis.in');
      expect(directive(policy, 'connect-src')).toContain('https://lumberjack.razorpay.com');
      expect(directive(policy, 'frame-src')).toContain('https://accounts.google.com/gsi/');
      // Exact Razorpay hosts (no wildcard); see tests/security-headers-hardening.spec.ts
      expect(directive(policy, 'img-src')).toContain('https://checkout.razorpay.com');
      expect(directive(policy, 'img-src')).not.toContain('*.razorpay.com');
      // Championship hero video (uploads on the API origin)
      expect(directive(policy, 'media-src')).toBe("media-src 'self' https://api.gcdis.in");
      expect(directive(policy, 'style-src')).toContain("'unsafe-inline'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("base-uri 'self'");
      expect(policy).toContain('upgrade-insecure-requests');
    });

    test('public site development policy keeps unsafe-eval (HMR) but never unsafe-inline for scripts', () => {
      const policy = loadCsp(web('src', 'lib', 'csp.ts'), DEV).buildContentSecurityPolicy('abc');
      const scriptSrc = directive(policy, 'script-src');
      expect(scriptSrc).toContain("'unsafe-eval'");
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(directive(policy, 'connect-src')).toContain('http://localhost:4000');
      expect(policy).not.toContain('upgrade-insecure-requests');
    });

    test('console production policy: nonce + strict-dynamic and no third-party scripts', () => {
      const policy = loadCsp(admin('src', 'lib', 'csp.ts'), PROD).buildContentSecurityPolicy('n0nce');
      const scriptSrc = directive(policy, 'script-src');
      expect(scriptSrc).toBe("script-src 'self' 'nonce-n0nce' 'strict-dynamic'");
      expect(policy).not.toContain('razorpay');
      expect(policy).not.toContain('accounts.google.com');
      expect(directive(policy, 'media-src')).toContain('https://api.gcdis.in');
      expect(policy).toContain("frame-src 'none'");
    });

    test('middleware sets the CSP response header and passes the nonce to the app', () => {
      for (const file of [web('src', 'middleware.ts'), admin('src', 'middleware.ts')]) {
        const code = read(file);
        expect(code).toContain("requestHeaders.set('x-nonce', nonce)");
        expect(code).toContain("requestHeaders.set('Content-Security-Policy', csp)");
        expect(code).toContain("response.headers.set('Content-Security-Policy', csp)");
        expect(code).toContain('_next/static');
        expect(code).toContain('next-router-prefetch');
      }
    });

    test('next.config.js no longer sends a static CSP (it would intersect with the nonce policy)', () => {
      for (const file of [web('next.config.js'), admin('next.config.js')]) {
        const code = read(file);
        expect(code).not.toMatch(/key:\s*'Content-Security-Policy'/);
        expect(code).toContain('X-Frame-Options');
        expect(code).toContain('nosniff');
      }
    });

    test('root layouts read the request headers so every page renders per request with the nonce', () => {
      for (const file of [web('src', 'app', 'layout.tsx'), admin('src', 'app', 'layout.tsx')]) {
        const code = read(file);
        expect(code).toContain("from 'next/headers'");
        expect(code).toContain("(await headers()).get('x-nonce')");
      }
    });
  });

  describe('2. Portal email verification and password reset', () => {
    test('verify-email page calls POST /auth/verify-email once and handles an invalid or expired link', () => {
      const page = read(web('src', 'app', 'portal', 'verify-email', 'page.tsx'));
      const client = read(web('src', 'app', 'portal', 'verify-email', 'VerifyEmailClient.tsx'));
      expect(page).toContain("referrer: 'no-referrer'");
      expect(page).toContain('robots: { index: false');
      expect(client).toContain("'/auth/verify-email'");
      expect(client).toContain('INVALID_OR_EXPIRED_TOKEN');
      // One request per token even when React re-runs the effect (Strict Mode, Fast Refresh)
      expect(client).toContain('verifyOnce(token)');
      expect(client).toContain('window.history.replaceState');
    });

    test('reset-password page validates locally, calls POST /auth/reset-password and directs to sign-in', () => {
      const page = read(web('src', 'app', 'portal', 'reset-password', 'page.tsx'));
      const client = read(web('src', 'app', 'portal', 'reset-password', 'ResetPasswordClient.tsx'));
      expect(page).toContain("referrer: 'no-referrer'");
      expect(client).toContain("'/auth/reset-password'");
      expect(client).toContain('newPassword: password');
      expect(client).toContain('INVALID_OR_EXPIRED_TOKEN');
      expect(client).toContain('passwordPolicyError');
      expect(client).toContain('href="/portal"');
      expect(client).toContain('window.history.replaceState');
    });

    test('token pages are served with Referrer-Policy: no-referrer', () => {
      expect(read(web('next.config.js'))).toContain("source: '/portal/:page(verify-email|reset-password)'");
      const middleware = read(web('src', 'middleware.ts'));
      expect(middleware).toContain("'/portal/verify-email', '/portal/reset-password'");
      expect(middleware).toContain("response.headers.set('Referrer-Policy', 'no-referrer')");
    });

    test('"Forgotten password?" opens the reset request form with a generic confirmation', () => {
      const view = read(web('src', 'app', 'portal', '_components', 'AuthView.tsx'));
      const form = read(web('src', 'app', 'portal', '_components', 'ForgotPasswordForm.tsx'));
      expect(view).toContain('setShowForgot(true)');
      expect(view).not.toContain('Online password reset is not yet available');
      expect(form).toContain("'/auth/forgot-password'");
      expect(form).toContain('If an account exists for this address, a reset link has been sent.');
    });

    test('dashboard shows the verification code step, resends the code and maps EMAIL_NOT_VERIFIED', () => {
      const page = read(web('src', 'app', 'portal', 'page.tsx'));
      const banner = read(web('src', 'app', 'portal', '_components', 'EmailVerificationBanner.tsx'));
      const step = read(web('src', 'app', 'portal', '_components', 'EmailCodeVerification.tsx'));
      const client = read(web('src', 'lib', 'api-client.ts'));
      expect(page).toContain('emailVerified === false && (');
      expect(page).toContain("isApiErrorCode(err, 'EMAIL_NOT_VERIFIED')");
      expect(banner).toContain('<EmailCodeVerification');
      expect(banner).toContain('A six-digit verification code has been sent to');
      expect(step).toContain("'/auth/resend-verification'");
      expect(step).toContain("'/auth/verify-email-code'");
      expect(client).toContain("code === 'EMAIL_NOT_VERIFIED'");
      expect(client).toContain('EMAIL_NOT_VERIFIED_MESSAGE');
    });

    test('new portal copy is formal (no exclamation marks in user-facing strings)', () => {
      const files = [
        web('src', 'app', 'portal', 'verify-email', 'VerifyEmailClient.tsx'),
        web('src', 'app', 'portal', 'reset-password', 'ResetPasswordClient.tsx'),
        web('src', 'app', 'portal', '_components', 'ForgotPasswordForm.tsx'),
        web('src', 'app', 'portal', '_components', 'EmailVerificationBanner.tsx'),
        web('src', 'app', 'portal', '_components', 'EmailCodeVerification.tsx'),
        web('src', 'app', 'portal', '_components', 'PasswordPolicy.tsx')
      ];
      for (const file of files) {
        const strings = read(file).match(/'[^'\n]*'|>[^<>{}\n]+</g) ?? [];
        for (const s of strings) expect(s).not.toMatch(/[A-Za-z.]!(\s|'|<|$)/);
      }
    });
  });

  describe('3. Password policy UI', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const policy = require(web('src', 'lib', 'password-policy.ts'));

    test('local checks mirror the API rules (length, three of four classes, email name part)', () => {
      expect(policy.passwordPolicyError('Short1!', 'a@b.org')).toMatch(/at least 12 characters/);
      expect(policy.passwordPolicyError('alllowercaseletters', 'a@b.org')).toMatch(/three of the following/);
      expect(policy.passwordPolicyError('Harbour.Lights2026', 'captain.smith@example.test')).toBeNull();
      expect(policy.passwordPolicyError('xx-captain.smith-2026X', 'captain.smith@example.test')).toMatch(/name part/);
      // Name parts shorter than three characters are ignored, as in the API
      expect(policy.passwordPolicyError('Abcdefghij12', 'ab@example.test')).toBeNull();
      expect(policy.passwordPolicyError('A1!' + 'x'.repeat(130))).toMatch(/must not exceed/);
      const checks = policy.passwordChecks('', 'someone@example.test');
      expect(checks.map((c: { id: string }) => c.id)).toEqual(['length', 'classes', 'email', 'breached']);
      expect(checks.find((c: { id: string }) => c.id === 'breached').met).toBeNull();
    });

    test('the console copy of the policy matches the portal copy except the staff minimum length (14)', () => {
      // Admin hardening: staff passwords need 14 characters; the rest of the rules stay identical
      const body = (src: string) =>
        src
          .replace(/^\/\*\*[\s\S]*?\*\/\s*/, '')
          .replace(/^(\/\*\*.*\*\/\s*)?export const PASSWORD_MIN_LENGTH = \d+;\s*$/m, '')
          .replace(/^\/\*\* Staff accounts:.*\*\/\s*$/m, '');
      const adminSrc = read(admin('src', 'lib', 'password-policy.ts'));
      const webSrc = read(web('src', 'lib', 'password-policy.ts'));
      expect(adminSrc).toContain('export const PASSWORD_MIN_LENGTH = 14;');
      expect(webSrc).toContain('export const PASSWORD_MIN_LENGTH = 12;');
      expect(body(adminSrc).trim()).toBe(body(webSrc).trim());
    });

    test('register, reset and the console forced password change show the policy with live checks', () => {
      // The registration form is the step-by-step RegisterWizard rendered by AuthView
      expect(read(web('src', 'app', 'portal', '_components', 'AuthView.tsx'))).toContain('<RegisterWizard');
      expect(read(web('src', 'app', 'portal', '_components', 'RegisterWizard.tsx'))).toContain('<PasswordPolicy id="reg-password-policy"');
      expect(read(web('src', 'app', 'portal', 'reset-password', 'ResetPasswordClient.tsx'))).toContain('<PasswordPolicy');
      const screens = read(admin('src', 'app', '_components', 'AuthScreens.tsx'));
      expect(screens).toContain('<PasswordPolicyList password={props.newPassword} email={props.email} />');
      const adminPage = read(admin('src', 'app', 'page.tsx'));
      expect(adminPage).toContain('passwordPolicyError(newPasswordInput, currentUser?.email)');
    });
  });
});
