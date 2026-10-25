import * as fs from 'fs';
import * as path from 'path';

/**
 * Security round 3 - infrastructure regression checks (static).
 * The behaviour behind these assertions was verified in throwaway containers
 * (nginx -t + live header/TLS/rate-limit probes, least-privilege SQL probes,
 * encrypted backup -> restore drill, hardened ClamAV EICAR scan).
 */
describe('Security round 3: infrastructure hardening', () => {
  const rootDir = path.resolve(__dirname, '..');
  const read = (...p: string[]) => fs.readFileSync(path.join(rootDir, ...p), 'utf-8');
  const exists = (...p: string[]) => fs.existsSync(path.join(rootDir, ...p));

  /** Returns the body of the `server { ... }` block whose server_name line matches. */
  function serverBlock(conf: string, serverName: string): string {
    const lines = conf.split('\n');
    const start = lines.findIndex((l) => l.trim() === `server_name ${serverName};`);
    expect(start).toBeGreaterThan(-1);
    let from = start;
    while (from > 0 && !/^\s*server\s*\{/.test(lines[from])) from--;
    let depth = 0;
    const out: string[] = [];
    for (let i = from; i < lines.length; i++) {
      out.push(lines[i]);
      depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
      if (depth === 0 && i > from) break;
    }
    return out.join('\n');
  }

  const files = [
    'docker-compose.prod.yml',
    'infra/nginx/nginx.conf',
    'infra/nginx/security-headers.conf',
    'infra/nginx/proxy-hide-headers.conf',
    'infra/nginx/well-known.conf',
    'infra/nginx/security.txt',
    'infra/postgres/init-roles.sh',
    'infra/postgres/post-migrate-grants.sql',
    'infra/postgres/verify-app-privileges.sql',
    'infra/backup/restore.sh',
    'infra/backup/verify-restore.sh',
    'infra/backup/Dockerfile',
    'infra/clamav/clamd.conf',
    '.github/workflows/ci-cd.yml',
    '.github/workflows/security.yml',
    '.github/dependabot.yml',
    'SECURITY.md',
    'docs/security/backup-and-restore.md',
    'docs/security/production-checklist.md',
  ];

  test('all infrastructure files exist and use LF line endings', () => {
    for (const f of files) {
      expect(exists(f)).toBe(true);
      expect(read(f).includes('\r')).toBe(false);
    }
  });

  describe('nginx', () => {
    const nginx = read('infra/nginx/nginx.conf');
    const headers = read('infra/nginx/security-headers.conf');
    const hide = read('infra/nginx/proxy-hide-headers.conf');

    test('www and admin do not add a CSP (apps send nonce CSPs); the API host keeps one', () => {
      expect(serverBlock(nginx, 'www.gcdis.in')).not.toContain('Content-Security-Policy');
      expect(serverBlock(nginx, 'admin.gcdis.in')).not.toContain('Content-Security-Policy');
      expect(headers).not.toMatch(/^\s*add_header\s+Content-Security-Policy/m);
      const api = serverBlock(nginx, 'api.gcdis.in');
      expect(api).toMatch(/add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'/);
      expect(api).toContain('proxy_hide_header Content-Security-Policy;');
      // the upstream nonce CSP must not be stripped at http level
      expect(hide).not.toMatch(/^\s*proxy_hide_header\s+Content-Security-Policy/m);
    });

    test('TLS policy: 1.2/1.3 only, AEAD ECDHE suites, no tickets, stapling', () => {
      expect(nginx).toContain('ssl_protocols       TLSv1.2 TLSv1.3;');
      expect(nginx).not.toMatch(/TLSv1(\.1)?\s/);
      expect(nginx).toContain('ssl_prefer_server_ciphers off;');
      expect(nginx).toContain('ssl_session_tickets off;');
      expect(nginx).toContain('ssl_stapling        on;');
      expect(nginx).toContain('ssl_stapling_verify on;');
      const ciphers = /ssl_ciphers\s+([^;]+);/.exec(nginx)![1].split(':');
      for (const c of ciphers) expect(c).toMatch(/^ECDHE-(ECDSA|RSA)-(AES(128|256)-GCM-SHA(256|384)|CHACHA20-POLY1305)$/);
      expect(nginx).toContain('server_tokens off;');
    });

    test('security headers and per-path Referrer-Policy for token-bearing pages', () => {
      expect(headers).toContain('add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;');
      expect(headers).toContain('add_header X-Content-Type-Options "nosniff" always;');
      expect(headers).toContain('add_header Permissions-Policy');
      expect(headers).toContain('add_header Cross-Origin-Opener-Policy');
      expect(headers).toContain('add_header Referrer-Policy $gcdis_referrer_policy always;');
      // reset-password / verify-email links carry one-time tokens: never leak them via Referer
      expect(nginx).toMatch(/map \$uri \$gcdis_referrer_policy \{[\s\S]*default\s+"strict-origin-when-cross-origin";[\s\S]*~\^\/portal\/\(verify-email\|reset-password\)\/\?\$\s+"no-referrer";/);
    });

    test('no add_header inside location blocks (would drop inherited security headers)', () => {
      for (const conf of [nginx, read('infra/nginx/well-known.conf')]) {
        const lines = conf.split('\n');
        let inLocation = 0;
        for (const line of lines) {
          if (/^\s*location\b.*\{\s*$/.test(line)) inLocation++;
          else if (inLocation && /^\s*\}\s*$/.test(line)) inLocation--;
          else if (inLocation) expect(line).not.toMatch(/^\s*add_header\b/);
        }
      }
    });

    test('rate-limit zones cover sign-in, recovery/verification and the general API', () => {
      expect(nginx).toMatch(/limit_req_zone \$binary_remote_addr zone=api_auth:10m rate=10r\/m;/);
      expect(nginx).toMatch(/limit_req_zone \$binary_remote_addr zone=api_auth_recovery:10m rate=5r\/m;/);
      expect(nginx).toMatch(/limit_req_zone \$binary_remote_addr zone=api_general:/);
      expect(nginx).toMatch(/location ~ \^\/api\/auth\/\(login\|register\|google\|2fa\/verify-login\)\$/);
      expect(nginx).toMatch(/location ~ \^\/api\/auth\/\(forgot-password\|reset-password\|verify-email\|resend-verification\|step-up/);
      expect(nginx).toContain('limit_req zone=api_auth_recovery');
      expect(nginx).toMatch(/client_max_body_size\s+10M;/);
      for (const d of ['client_body_timeout', 'client_header_timeout', 'send_timeout', 'large_client_header_buffers']) {
        expect(nginx).toContain(d);
      }
    });

    test('security.txt is served on the public hosts and is valid (RFC 9116)', () => {
      const txt = read('infra/nginx/security.txt');
      expect(txt).toMatch(/^Contact: mailto:gcdisgalgotias@gmail\.com$/m);
      expect(txt).toMatch(/^Preferred-Languages: en$/m);
      const expires = /^Expires: (.+)$/m.exec(txt)![1];
      const ms = Date.parse(expires) - Date.now();
      expect(ms).toBeGreaterThan(0); // renew before it lapses (production checklist)
      expect(ms).toBeLessThan(400 * 24 * 3600 * 1000); // RFC 9116: less than a year ahead is recommended
      expect(read('infra/nginx/well-known.conf')).toContain('location = /.well-known/security.txt');
      for (const host of ['gcdis.in', 'www.gcdis.in', 'admin.gcdis.in', 'api.gcdis.in']) {
        expect(serverBlock(nginx, host)).toContain('include /etc/nginx/well-known.conf;');
      }
    });
  });

  describe('docker-compose.prod.yml', () => {
    const compose = read('docker-compose.prod.yml');
    const service = (name: string): string => {
      const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z_-]+:\\n|\\nnetworks:|$)`).exec(compose);
      expect(m).not.toBeNull();
      return m![1];
    };

    test('ClamAV service: official image, internal network, healthcheck, volume, memory limit', () => {
      const clam = service('clamav');
      // Official multi-architecture (amd64 + arm64) Debian variant, pinned by digest
      expect(clam).toMatch(/image: clamav\/clamav-debian:\d[^@\s]*@sha256:[a-f0-9]{64}/);
      expect(clam).not.toContain('ports:');
      expect(clam).toContain('clamdcheck.sh');
      expect(clam).toContain('clamav_db:/var/lib/clamav');
      expect(clam).toMatch(/memory: \d+M/);
      expect(clam).toContain('- gcdis-data');
      expect(compose).toMatch(/gcdis-data:\n\s+driver: bridge\n\s+internal: true/);
    });

    test('API receives ClamAV, mail, HIBP and security-alert settings', () => {
      const api = service('api');
      for (const v of [
        'CLAMAV_HOST=clamav', 'CLAMAV_PORT=3310', 'CLAMAV_REQUIRED=${CLAMAV_REQUIRED:-true}',
        'SMTP_HOST=${SMTP_HOST:?', 'SMTP_PORT=', 'SMTP_USER=', 'SMTP_PASSWORD=', 'SMTP_SECURE=', 'MAIL_FROM=${MAIL_FROM:?',
        'HIBP_CHECK=${HIBP_CHECK:-true}', 'SECURITY_ALERT_WEBHOOK_URL=', 'SECURITY_ALERT_EMAIL=',
      ]) {
        expect(api).toContain(v);
      }
    });

    test('every long-running service is hardened and resource limited', () => {
      for (const name of ['proxy', 'web', 'admin', 'api', 'postgres', 'redis', 'clamav', 'backup', 'certbot']) {
        const s = service(name);
        expect(s).toMatch(/<<: \*app-hardening/);
        expect(s).toMatch(/memory: \d+M/);
        expect(s).toMatch(/pids: \d+/);
        if (name !== 'certbot') expect(s).toContain('healthcheck:');
      }
      expect(compose).toMatch(/x-app-hardening: &app-hardening\n\s+security_opt:\n\s+- no-new-privileges:true\n\s+cap_drop:\n\s+- ALL\n\s+read_only: true/);
      // only the proxy publishes ports; data services are not on the proxy network
      expect((compose.match(/^\s+ports:/gm) || []).length).toBe(1);
      for (const name of ['postgres', 'redis']) expect(service(name)).not.toContain('gcdis-internal');
      expect(service('cert_init')).toContain('network_mode: none');
    });

    test('restore drill profile restores into a scratch server, never production', () => {
      expect(service('restore-verify')).toContain('RESTORE_PGHOST: restore-scratch');
      expect(service('restore-verify')).toContain('./infra/backups:/backups:ro');
      expect(service('restore-scratch')).toContain('/var/lib/postgresql/data');
    });
  });

  describe('database least privilege', () => {
    test('post-migrate grants set default privileges for future tables and keep audit_logs append-only', () => {
      const sql = read('infra/postgres/post-migrate-grants.sql');
      expect(sql).toMatch(/ALTER DEFAULT PRIVILEGES IN SCHEMA public\s+GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gcdis_app;/);
      expect(sql).toMatch(/ALTER DEFAULT PRIVILEGES IN SCHEMA public\s+GRANT USAGE, SELECT ON SEQUENCES TO gcdis_app;/);
      expect(sql).toContain('REVOKE CREATE ON SCHEMA public FROM gcdis_app;');
      expect(sql).toContain('REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM gcdis_app;');
      expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs FROM gcdis_app;');
      const init = read('infra/postgres/init-roles.sh');
      expect(init).toContain('REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;');
      expect(init).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE gcdis_admin IN SCHEMA public');
    });

    test('verification script probes DML, DDL, TRUNCATE and audit immutability as gcdis_app', () => {
      const v = read('infra/postgres/verify-app-privileges.sql');
      for (const probe of ['TRUNCATE public.', 'ALTER TABLE public.', 'DROP TABLE public.', 'CREATE TABLE public.zz_priv_probe', 'UPDATE public.audit_logs', 'DELETE FROM public.audit_logs']) {
        expect(v).toContain(probe);
      }
      expect(v).toContain("current_user <> 'gcdis_app'");
    });
  });

  describe('backups', () => {
    test('restore.sh verifies the HMAC before decrypting and is guarded', () => {
      const r = read('infra/backup/restore.sh');
      expect(r.indexOf('verify_hmac "$ENC_FILE"')).toBeGreaterThan(-1);
      expect(r.indexOf('verify_hmac "$ENC_FILE"')).toBeLessThan(r.indexOf('| pg_restore $CLEAN_FLAGS'));
      expect(r).toContain('--single-transaction --exit-on-error');
      expect(r).toContain('pass --clean to replace them');
      expect(r).toContain('refusing to run non-interactively without --yes');
      expect(r).toContain('-pass env:BACKUP_ENCRYPTION_KEY');
    });

    test('verify-restore.sh restores into a scratch DB and compares row counts', () => {
      const v = read('infra/backup/verify-restore.sh');
      expect(v).toContain('RESTORE_PGHOST');
      expect(v).toContain('--create --yes');
      expect(v).toContain('MAX_DRIFT_PCT');
      expect(v).toContain('DROP DATABASE IF EXISTS');
      expect(read('infra/backup/Dockerfile')).toContain('restore.sh verify-restore.sh');
    });
  });

  describe('CI security gates', () => {
    const ci = read('.github/workflows/ci-cd.yml');
    const sec = read('.github/workflows/security.yml');
    const all = `${ci}\n${sec}`;

    test('every action is pinned to a full commit SHA', () => {
      const uses = all.match(/uses:\s*\S+/g) || [];
      expect(uses.length).toBeGreaterThan(5);
      for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
    });

    test('gitleaks, npm audit, CodeQL and Trivy (HIGH/CRITICAL, ignore-unfixed) gate the build', () => {
      expect(ci).toContain('gitleaks/gitleaks-action@');
      expect(all).toContain('npm audit --omit=dev --audit-level=high');
      expect(sec).toContain('github/codeql-action/init@');
      expect(sec).toContain('languages: javascript-typescript');
      expect(ci).toContain('aquasecurity/trivy-action@');
      expect(ci).toContain('severity: CRITICAL,HIGH');
      expect(ci).toContain('ignore-unfixed: true');
      expect(ci).toContain("exit-code: '1'");
    });

    test('dependabot covers npm, docker and github-actions weekly', () => {
      const dep = read('.github/dependabot.yml');
      for (const eco of ['npm', 'docker', 'github-actions']) {
        expect(dep).toMatch(new RegExp(`package-ecosystem: ${eco}\\n`));
      }
      expect((dep.match(/interval: weekly/g) || []).length).toBeGreaterThanOrEqual(3);
    });
  });
});
