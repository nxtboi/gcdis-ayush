# Production security checklist

Work through this list before the first production deployment, and review it after
every security-relevant change and at least once a quarter. Each item names where
the setting lives.

## 1. Secrets

- [ ] `.env` exists only on the production host, is owned by the deploy user and has
      mode `0600`. It is never committed (`.gitignore`) and never copied into images
      (`.dockerignore`).
- [ ] Every secret is a fresh random value, not copied from `.env.example`, development
      or another environment:
      `openssl rand -hex 32` (hex keeps them safe inside URLs such as `REDIS_URL`).
      Applies to `POSTGRES_PASSWORD`, `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_APP_PASSWORD`,
      `POSTGRES_BACKUP_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`, `PASS_SIGNING_SECRET`, `FILE_ENCRYPTION_KEY`, `VERIFICATION_CODE_KEY`,
      `JWT_ADMIN_SECRET`, `COOKIE_SECRET`, `PASS_SIGNING_SECRET`, `UPLOAD_SIGNING_SECRET`,
      `TWO_FACTOR_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY`.
- [ ] All secrets are stored in the team password manager; `BACKUP_ENCRYPTION_KEY`
      additionally has a sealed offline copy held by a second person.
- [ ] `SUPER_ADMIN_TEMP_PASSWORD` is removed from `.env` after the first super admin
      has signed in and changed it.

### Rotation

| Secret | Rotate | How / effect |
| --- | --- | --- |
| `JWT_SECRET`, `JWT_ADMIN_SECRET`, `COOKIE_SECRET`, `PASS_SIGNING_SECRET`, `UPLOAD_SIGNING_SECRET` | yearly, and immediately after a suspected leak | change in `.env`, `docker compose up -d api`; every session is invalidated and users sign in again |
| `PASS_SIGNING_SECRET` | only after a leak | previously issued passes and QR codes stop verifying; re-issue them |
| `TWO_FACTOR_ENCRYPTION_KEY` | only after a leak | stored TOTP secrets become unreadable: staff must re-enrol 2FA |
| PostgreSQL role passwords | yearly / after a leak | update `.env`, then re-run the idempotent role script: `docker compose -f docker-compose.prod.yml exec postgres sh /docker-entrypoint-initdb.d/init-roles.sh`, then `up -d` |
| `REDIS_PASSWORD` | yearly / after a leak | update `.env`, `docker compose up -d redis api` |
| `BACKUP_ENCRYPTION_KEY` | only after a leak | new backups use the new key; keep the old key until all backups made with it have expired |
| Razorpay keys and webhook secret | yearly / after a leak | regenerate in the Razorpay dashboard, update `.env`, restart `api` |
| SMTP credentials, AWS keys | yearly / after a leak | regenerate at the provider, update `.env`, restart the affected service |

## 2. Payments (Razorpay)

- [ ] Live keys only in production: `RAZORPAY_KEY_ID` starts with `rzp_live_`;
      test keys (`rzp_test_`) are used everywhere else.
- [ ] Webhook created in the Razorpay dashboard (Settings, Webhooks):
      URL `https://api.gcdis.in/api/payments/webhook`, events `payment.captured`,
      `payment.failed`, `order.paid` (and `refund.*` if refunds are used), with a
      long random secret (`openssl rand -hex 32`) entered as `RAZORPAY_WEBHOOK_SECRET`.
- [ ] Send a test webhook from the dashboard and confirm it is accepted, and that a
      request with a wrong signature is rejected.
- [ ] Dashboard access restricted to named people with 2FA enabled.
- [ ] Daily reconciliation owner named (payments in the console against the Razorpay
      settlement report).

## 3. Email (SMTP)

- [ ] `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `MAIL_FROM`
      set (compose refuses to start without `SMTP_HOST` and `MAIL_FROM`). Use port 587
      with STARTTLS (`SMTP_SECURE=false`) or 465 with `SMTP_SECURE=true`.
- [ ] Sending domain has SPF, DKIM and a DMARC record (`p=quarantine` or stricter).
- [ ] Verification and password-reset emails received and links work
      (`https://www.gcdis.in/portal/verify-email?token=...`,
      `/portal/reset-password?token=...`). These pages are served with
      `Referrer-Policy: no-referrer` (nginx) so the token never leaks via Referer.
- [ ] `HIBP_CHECK=true` (default) and outbound HTTPS to `api.pwnedpasswords.com` works.

## 4. Upload malware scanning (ClamAV)

- [ ] `clamav` service running and healthy:
      `docker compose -f docker-compose.prod.yml ps clamav`.
      First start can take several minutes while signatures load.
- [ ] `CLAMAV_REQUIRED=true` (default): uploads are refused with 503 while the scanner
      is unreachable.
- [ ] EICAR test: uploading the standard EICAR test file through the portal is rejected.
- [ ] Signatures are fresh: `docker logs gcdis-clamav | grep -i "daily"` shows a
      recent update (freshclam checks 12 times a day through `gcdis-egress`).
- [ ] Host has at least 3 GB of memory available for ClamAV (limit in compose).
- [ ] `UPLOAD_VIDEO_MAX_MB` (championship hero video, default 60) is at most 63 and stays
      below nginx `client_max_body_size 64M` on `/api/uploads/stream` and clamd
      `StreamMaxLength 70M` (`infra/clamav/clamd.conf`); raise all three together.
      Uploading a test MP4 in Championship Page succeeds and a 416 / 206 check passes:
      `curl -sI -H "Range: bytes=0-1" https://api.gcdis.in/api/uploads/files/<key>`
      answers `206` with `Accept-Ranges: bytes`.

## 5. Access control

- [ ] Decide whether the staff console is restricted to the office and VPN egress
      addresses. The restriction is **prepared but OFF by default**: every rule in
      `infra/nginx/admin-allowlist.conf` is commented out and `ADMIN_IP_ALLOWLIST` is
      empty. If you enable it, follow "Admin IP allow-list go-live" below.
- [ ] Every staff account has 2FA enabled; the super admin account is used only for
      account administration.
- [ ] Staff accounts of people who leave are disabled the same day.
- [ ] SSH to the host: key-only, no root login, firewall allows only 22 (from known
      addresses), 80 and 443.
- [ ] GitHub: branch protection on `main` (required reviews, required status checks
      `ci-cd` and `security`), secret scanning and Dependabot alerts enabled,
      `production` environment requires approval.

### Staff console hardening (sessions, step-up, audit chain)

- [ ] `ADMIN_IDLE_TIMEOUT_MIN` (default 30) and `ADMIN_MAX_SESSIONS` (default 3) are set as
      intended in `.env`; after deploy, an idle console signs out with "You were signed out
      after 30 minutes of inactivity" and a fourth sign-in signs out the oldest session
      (alert `STAFF_SESSION_LIMIT_REACHED`).
- [ ] `SECURITY_ALERT_WEBHOOK_URL` / `SECURITY_ALERT_EMAIL` receive the new alerts
      `STAFF_NEW_DEVICE_LOGIN`, `STAFF_SESSION_LIMIT_REACHED`, `SUPER_ADMIN_ROLE_REVOKED` and
      `AUDIT_CHAIN_BROKEN`; staff receive the "New sign-in to your staff account" email (SMTP).
- [ ] Staff passwords: new and changed passwords need at least 14 characters (captains 12).
      Ask existing staff to change shorter passwords; they are not forced to.
- [ ] Exporting the audit log and opening ID proofs / documents in the console ask for an
      authenticator code (step-up, valid 10 minutes).
- [ ] `ADMIN_LOGOUT_CLEAR_SITE_DATA`: keep the default (`"cache", "storage"`). Adding `"cookies"`
      clears every cookie of the registrable domain (e.g. `gcdis.in`), which also signs staff out of the
      team portal in the same browser; the console's own session cookies are cleared on sign-out anyway.
- [ ] Trusted Types are **enforced** on the console in production (`ADMIN_TRUSTED_TYPES`
      empty). After each deploy, open every console tab once and check `/api/csp-report`
      logs for `require-trusted-types-for` reports; `ADMIN_TRUSTED_TYPES=report-only` and
      `docker compose -f docker-compose.prod.yml up -d admin` is the emergency fallback.
- [ ] Run the migration `20261017000000_admin_session_idle_and_audit_chain`
      (`npm run db:migrate`); then a Super Administrator runs **Security > Verify Audit
      Chain** and stores the reported head position and hash (e.g. in the password
      manager) weekly; a later verification that reports a lower head, or any broken
      link, means audit rows were removed or altered.
- [ ] `curl -sI https://admin.gcdis.in/` shows `Cache-Control: no-store`,
      `X-Robots-Tag: noindex, nofollow` and a CSP containing `require-trusted-types-for`;
      `https://admin.gcdis.in/robots.txt` disallows everything.

### Admin IP allow-list go-live

Two layers must carry the **same** ranges: nginx gates the console pages on
`admin.gcdis.in`; the API's `ADMIN_IP_ALLOWLIST` gates staff sign-in and every staff
token on `api.gcdis.in` (the console's browser calls go there, which nginx's admin
rules do not cover).

1. Collect the egress addresses of every place staff work from (office NAT, VPN
   gateway, IPv6 prefixes too if the office has IPv6). Check from each place with
   `curl -s https://ifconfig.me` (and `curl -6 -s https://ifconfig.me`).
   Have a plan for staff on the road (VPN) before enabling; a super admin locked out
   can only be let back in from the host.
2. Edit `infra/nginx/admin-allowlist.conf`: uncomment and fill in one `allow <cidr>;`
   line per range and finish with `deny all;` (last rule; first match wins):
   ```nginx
   allow 203.0.113.0/24;
   allow 198.51.100.17;
   deny  all;
   ```
3. Set the same ranges, comma-separated, in `.env`:
   `ADMIN_IP_ALLOWLIST="203.0.113.0/24, 198.51.100.17"`.
   A value with no valid entry denies **all** staff; invalid entries are logged and
   ignored at API start-up.
4. Apply:
   ```sh
   docker compose -f docker-compose.prod.yml exec proxy nginx -t
   docker compose -f docker-compose.prod.yml exec proxy nginx -s reload
   docker compose -f docker-compose.prod.yml up -d api
   ```
5. Verify: from an allowed network the console loads and a staff sign-in (with 2FA)
   succeeds; from an outside network (phone on mobile data) `https://admin.gcdis.in/`
   returns 403 and a staff sign-in through the API is refused.
6. Record the ranges and their owner in the password manager entry for the console,
   and review them quarterly with this checklist.

Rollback: comment the nginx lines out again and `nginx -s reload`; set
`ADMIN_IP_ALLOWLIST=""` and `docker compose -f docker-compose.prod.yml up -d api`.

## 6. Database and containers

- [ ] The API connects as `gcdis_app` (DML only); migrations run as `gcdis_admin`
      through the `migrate` service, which re-applies `post-migrate-grants.sql`.
- [ ] Least privilege verified after every deployment that adds a migration:
      ```sh
      docker compose -f docker-compose.prod.yml exec -T -e PGPASSWORD="$POSTGRES_APP_PASSWORD" postgres \
        psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U gcdis_app -d "$POSTGRES_DB" -f - \
        < infra/postgres/verify-app-privileges.sql
      ```
- [ ] `docker compose -f docker-compose.prod.yml config -q` succeeds; only the proxy
      publishes ports (`docker ps` shows nothing else bound to the host).
- [ ] Containers run with `no-new-privileges`, all capabilities dropped (only the few
      listed per service added back), read-only root filesystems and resource limits.
- [ ] Images rebuilt monthly (`docker compose build --pull`) and after Dependabot
      base-image updates; Trivy in CI blocks HIGH/CRITICAL fixable vulnerabilities.
- [ ] Every third-party image (compose files, `infra/backup/Dockerfile`, CI service
      containers) is pinned as `image:tag@sha256:<multi-arch index digest>`; Dependabot
      (`docker`, `docker-compose` ecosystems) raises PRs that bump the digests. To
      re-resolve one by hand without pulling it:
      `docker buildx imagetools inspect nginx:1.28-alpine` (use the top-level `Digest`).
      `tests/infra-hardening.spec.ts` fails on any unpinned image.
- [ ] Every service in `docker-compose.prod.yml` uses the `json-file` log driver with
      rotation (`max-size: 10m`, `max-file: 5`, i.e. at most 50 MB per container), so
      logs can never fill the disk.
- [ ] The `api` healthcheck (`curl -f .../api/health`) turns the container unhealthy
      when `/api/health` answers non-2xx (503 while PostgreSQL or Redis is down).

## 7. TLS and web edge

- [ ] Real certificate issued (`infra/ssl/issue-certs.sh`); renewal works
      (`docker compose run --rm certbot renew --dry-run`).
- [ ] SSL Labs grade A+ for `www`, `admin` and `api`; TLS 1.0/1.1 refused.
- [ ] HSTS preload submitted at hstspreload.org only once every subdomain serves HTTPS
      (the header already carries `preload`; submission is hard to undo).
- [ ] Response headers checked on each host (CSP with a nonce on `www` and `admin`,
      static CSP on `api`, HSTS, `X-Content-Type-Options`, `Referrer-Policy`,
      `Permissions-Policy`, `Cross-Origin-Opener-Policy`, exactly one
      `Cross-Origin-Resource-Policy`; nginx adds `same-site` on www / admin only when
      the app sends none). No `Server` version and no `X-Powered-By`.
- [ ] nginx limits in place (`infra/nginx/nginx.conf`): per-IP `html_ssr` zone
      (20 r/s, burst 40) on www / admin pages with `/_next/static`, `/_next/image` and
      `/images` exempt; the API auth zones; request bodies capped at 1 MB on www / admin,
      10 MB on the API and 25 MB on `/api/uploads` only (64 MB on `/api/uploads/stream`
      for the staff-only championship hero video; the API keeps 25 MB for every other
      upload purpose).
- [ ] `https://www.gcdis.in/.well-known/security.txt` is served; renew its `Expires`
      field (`infra/nginx/security.txt`) before it lapses (calendar reminder one month
      ahead). The CI test fails once it has expired.
- [ ] API abuse limits reviewed: every route has a per-IP default of `API_DEFAULT_RATE_LIMIT_PER_MIN`
      (300/min; health and the Razorpay webhook exempt) on top of its own limits; live-scoreboard sockets
      capped by `WS_MAX_CONNECTIONS_PER_IP` (20) and `WS_MAX_ROOMS_PER_SOCKET` (10). On event day, if many
      teams share one campus IP and see "too many requests", raise the default in `.env` and restart the API.
- [ ] Recommended: Cloudflare (free plan) in front for DDoS and bot protection, following
      `docs/security/cdn-cloudflare.md`. If enabled, `infra/nginx/cloudflare-realip.conf` MUST be
      enabled at the same time (otherwise every visitor shares Cloudflare's IP for rate limits and the
      admin allow-list), and the VPS firewall must accept 80/443 only from Cloudflare's ranges.

## 8. Backups

- [ ] `BACKUP_S3_BUCKET` set, bucket versioned with Object Lock and a lifecycle rule,
      write-only IAM credential (see backup-and-restore.md).
- [ ] `infra/backups/` on the host has mode 0700.
- [ ] Backup container healthy and `infra/backups/.last_success` is less than 26 h old.
- [ ] Monthly restore drill done and logged
      (`docker compose -f docker-compose.prod.yml --profile restore-drill run --rm restore-verify`).

## 9. Monitoring and alerting

- [ ] External uptime monitor on `https://www.gcdis.in/`, `https://admin.gcdis.in/` and
      `https://api.gcdis.in/api/health` (alert after 2 failed checks).
- [ ] `SECURITY_ALERT_WEBHOOK_URL` (https, e.g. a Slack or Teams incoming webhook) and/or
      `SECURITY_ALERT_EMAIL` set, and a test alert received.
- [ ] Alerts on: unhealthy containers (`docker ps --filter health=unhealthy`),
      `infra/backups/.last_failure` present, certificate expiry under 14 days, disk usage
      above 80 %, repeated `FAILED_LOGIN_ALERT` / `PAYMENT_FAILURE_ALERT` log events.
- [ ] Logs retained for at least 90 days. Local `json-file` rotation (50 MB per
      container) protects the disk but will not hold 90 days on a busy proxy, so ship
      the logs to a log service or archive them; `audit_logs` is append-only and never
      pruned without approval.

## 10. Incident response

Roles: an **incident lead** (decides and coordinates) and a **scribe** (keeps a
timestamped log). Contact list kept in the password manager.

1. **Detect and triage.** Confirm the report or alert, classify severity
   (critical: data breach, payment tampering, admin compromise; high: exploitable
   vulnerability without evidence of abuse; medium/low otherwise). Open an incident log.
2. **Contain.**
   - Block offending addresses in nginx (`deny` in the relevant server block, then
     `docker compose exec proxy nginx -s reload`), or restrict the console with
     `admin-allowlist.conf`.
   - Disable affected accounts in the console; revoke sessions (rotate `JWT_*` and
     `COOKIE_SECRET` to sign everyone out).
   - Rotate any secret that may be exposed (table in section 1).
   - If needed take the site offline: `docker compose -f docker-compose.prod.yml stop proxy`.
3. **Preserve evidence** before changing anything else: export `audit_logs`,
   `docker compose logs --since 72h > incident-<date>.log`, copy the latest backup,
   note container image digests (`docker compose images`).
4. **Eradicate and recover.** Fix the root cause, deploy through CI, restore data from
   backup if it was altered (backup-and-restore.md), verify least privilege and
   headers, then reopen.
5. **Notify.** Inform the GCDIS organising committee and Galgotias University IT.
   For a personal-data breach, notify CERT-In within 6 hours of noticing it
   (cert-in.org.in, incident@cert-in.org.in) and assess duties under India's Digital
   Personal Data Protection Act 2023 (notify the Data Protection Board and affected
   people). Inform Razorpay if payment data or keys were involved.
6. **Review** within 2 weeks: timeline, root cause, what worked, follow-up actions with
   owners and dates. Update this checklist.
