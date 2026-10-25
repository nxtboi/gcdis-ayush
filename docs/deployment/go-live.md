# GCDIS go-live guide

Readiness audit of 16 October 2026: code, types, 1,416 tests, production builds (API, web, admin), the
production compose file and the nginx config all pass. The one code blocker found (the API crashing at
boot on the read-only filesystem because of the PDF cache directory) is fixed. What remains is setup.

Hosting on Oracle Cloud Always Free (no cost): set the server up with [`oracle-cloud.md`](oracle-cloud.md) first.

## 1. Before the first deploy (owner)

| # | Task | Notes |
|---|---|---|
| 1 | Commit all work, then remove the old QA invoice from git history | `git filter-repo --path apps/api/storage --invert-paths` then `git gc --prune=now` (do this before the first push) |
| 2 | Create a **private** GitHub repository and push | CI builds the images from git and deploys by commit SHA |
| 3 | GitHub `production` environment secrets | `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`; add branch protection on `main` |
| 4 | Server | Ubuntu LTS, at least 8 GB RAM and 2 vCPU, Docker Engine + compose plugin, key-only SSH, firewall allowing 22 (restricted), 80, 443 |
| 5 | DNS | A records for `gcdis.in`, `www`, `admin`, `api` to the server (DNS only at first; see `docs/security/cdn-cloudflare.md` before turning on Cloudflare proxying) |
| 6 | Razorpay live mode | `rzp_live_` key pair; webhook `https://api.gcdis.in/api/payments/webhook` for `payment.captured`, `payment.failed`, `order.paid` (and `refund.*`), secret from `openssl rand -hex 32`; send a test webhook |
| 7 | Email (Brevo) | Authenticate the `gcdis.in` domain (SPF `include:spf.brevo.com`, DKIM records, DMARC); `MAIL_FROM="GCDIS Championship <no-reply@gcdis.in>"` (a gmail.com sender lands in spam); authorise the **server's** IP in Brevo |
| 8 | Google sign-in (optional) | Add `https://www.gcdis.in` to the OAuth client's authorised JavaScript origins; set `GOOGLE_CLIENT_ID` |
| 9 | Off-site backups (recommended) | Versioned S3 bucket with a write-only key: `BACKUP_S3_BUCKET`, `AWS_*` |
| 10 | Alerts (recommended) | `SECURITY_ALERT_WEBHOOK_URL` and/or `SECURITY_ALERT_EMAIL`; an uptime monitor on www, admin and `api/health` |

## 2. Production `.env` (create fresh on the server, never copy the local one)

Generate every secret with `openssl rand -hex 32`. Keep all of them in a password manager, and an offline
sealed copy of `BACKUP_ENCRYPTION_KEY` **and** `FILE_ENCRYPTION_KEY` (without them backups and uploaded
documents cannot be read).

Required: `POSTGRES_DB`, `POSTGRES_PASSWORD`, `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_APP_PASSWORD`,
`POSTGRES_BACKUP_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`, `JWT_ADMIN_SECRET` (different from
`JWT_SECRET`), `COOKIE_SECRET`, `TWO_FACTOR_ENCRYPTION_KEY`, `PASS_SIGNING_SECRET`, `UPLOAD_SIGNING_SECRET`,
`FILE_ENCRYPTION_KEY` (exactly 64 hex characters), `VERIFICATION_CODE_KEY`, `BACKUP_ENCRYPTION_KEY`,
`RAZORPAY_KEY_ID` (live), `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `SMTP_HOST`, `SMTP_USER`,
`SMTP_PASSWORD`, `MAIL_FROM`.

First run only: `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_TEMP_PASSWORD` (remove after signing in).

Defaults are fine for: `PUBLIC_SITE_URL` (`https://www.gcdis.in`), `ADMIN_SITE_URL`, `SMTP_PORT` 587,
`ADMIN_IDLE_TIMEOUT_MIN` 30, `ADMIN_MAX_SESSIONS` 3, `API_DEFAULT_RATE_LIMIT_PER_MIN` 300,
`UPLOAD_VIDEO_MAX_MB` 60. Never set in production: `SHOW_PLACEHOLDER_CONTENT`,
`NEXT_PUBLIC_SHOW_PLACEHOLDER_CONTENT`, `DEV_SEED_CAPTAIN_PASSWORD`, `MAIL_OUTBOX_DIR`.

`chmod 600 .env`, then `docker compose -f docker-compose.prod.yml config -q`.

## 3. First deploy (server)

1. `git clone <repo> /srv/gcdis && cd /srv/gcdis && install -d -m 700 infra/backups`
2. Create `.env` (section 2). `docker login ghcr.io` with a `read:packages` token.
3. Push to `main` (CI tests, builds, scans, pushes images, runs `scripts/deploy.sh`), or on the server:
   `IMAGE_PREFIX=ghcr.io/<owner> IMAGE_TAG=<commit-sha> sh scripts/deploy.sh`
4. Seed the event, categories, fees and home content **once**:
   `docker compose -f docker-compose.prod.yml --profile bootstrap run --rm bootstrap-admin npx --no-install ts-node --transpile-only prisma/seed.ts`
5. Check database least privilege:
   `docker compose -f docker-compose.prod.yml exec -T -e PGPASSWORD="$POSTGRES_APP_PASSWORD" postgres psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U gcdis_app -d "$POSTGRES_DB" -f - < infra/postgres/verify-app-privileges.sql`
6. Super admin: `docker compose -f docker-compose.prod.yml --profile bootstrap run --rm bootstrap-admin`,
   sign in at `https://admin.gcdis.in`, change the password, enrol 2FA, remove the temporary password from `.env`.
7. TLS: `CERTBOT_EMAIL=… CERTBOT_DOMAINS="gcdis.in www.gcdis.in admin.gcdis.in api.gcdis.in" CERTBOT_STAGING=1 sh infra/ssl/issue-certs.sh`,
   then again without `CERTBOT_STAGING`; then a renewal dry run.

## 4. Content in the staff console before announcing

- Site Information: venue name and address (currently "Needs input").
- Prizes: allocate the remaining ₹16,000 of the ₹1,00,000 pool (or record it as unallocated).
- Home Page Sections: replace or switch off sample entries (hidden on the live site anyway).
- Home Page Hero: update the announcement (the seeded one is old).
- Championship Page: hero video, poster, drone and arena photos, section media.
- Sponsors: switch on only when real sponsors are added.
- Repeat until the Overview checklist shows ready to go live.

## 5. Smoke test after go-live

Headers on all three hosts; an EICAR test upload is rejected; a new captain registers and receives the
verification code; a small live payment and a refund; invoice and pass PDF downloads; the live scoreboard;
a hero video upload; `infra/backups/.last_success` exists and the copy reached S3; a restore drill
(`--profile restore-drill run --rm restore-verify`).
