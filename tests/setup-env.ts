import * as os from 'os';
import * as path from 'path';

// Redirect local upload storage to an OS temp dir so test runs never write
// fixture files into the repository's ./uploads directory.
if (!process.env.STORAGE_LOCAL_DIR) {
  process.env.STORAGE_LOCAL_DIR = path.join(os.tmpdir(), 'gcdis-test-uploads');
}

// Tests must never send real email: blank the SMTP settings before anything loads .env (dotenv does
// not override variables that are already set), so MailService keeps messages in memory under Jest.
for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'MAIL_FROM']) {
  process.env[key] = '';
}

// Tests use the in-memory rate-limit store: never connect to the developer's Redis (shared buckets would
// make runs order-dependent). Specs that exercise Redis inject a fake client.
process.env.REDIS_URL = '';
