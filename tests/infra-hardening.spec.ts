import * as fs from 'fs';
import * as path from 'path';

// js-yaml ships without bundled types; only `load` is needed (merge keys and aliases are resolved).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml') as { load: (src: string) => unknown };

/**
 * Infrastructure hardening (static checks): digest-pinned third-party images, nginx 1.28,
 * nginx request limits / headers, log rotation on every production service, the api
 * healthcheck and the (disabled-by-default) admin IP allow-list.
 *
 * The nginx behaviour behind these assertions was verified against the pinned
 * nginx:1.28-alpine image: `nginx -t`, CORP fallback (added only when the upstream sends
 * none), 429 from the html_ssr zone with static assets exempt, 413 above 1 MB on www/admin.
 */
describe('Infrastructure hardening', () => {
  const rootDir = path.resolve(__dirname, '..');
  const read = (...p: string[]) => fs.readFileSync(path.join(rootDir, ...p), 'utf-8');

  const DIGEST_REF = /^[a-z0-9][a-z0-9._\/-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/;

  /**
   * Images that are deliberately NOT digest-pinned, with the reason. Anything else that is
   * not `name:tag@sha256:<digest>` fails the test.
   */
  const UNPINNED_EXCEPTIONS: Record<string, string> = {
    // Built from this repository (apps/*/Dockerfile); CI pushes them tagged by commit SHA.
    '${IMAGE_PREFIX:-local}/gcdis-web:${IMAGE_TAG:-latest}': 'first-party image built from apps/web',
    '${IMAGE_PREFIX:-local}/gcdis-admin:${IMAGE_TAG:-latest}': 'first-party image built from apps/admin',
    '${IMAGE_PREFIX:-local}/gcdis-api:${IMAGE_TAG:-latest}': 'first-party image built from apps/api',
    '${IMAGE_PREFIX:-local}/gcdis-api-migrate:${IMAGE_TAG:-latest}': 'first-party image (apps/api builder stage)',
    // Built on the host from infra/backup/Dockerfile, whose FROM line is digest-pinned.
    'gcdis-backup:local': 'host-built from infra/backup/Dockerfile (base image digest-pinned)'
  };

  /** `image:` values from a compose file or workflow (quotes stripped). */
  function imageRefs(src: string): string[] {
    return [...src.matchAll(/^\s*image:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/gm)].map((m) => m[1]);
  }

  /** Base images of a Dockerfile, ignoring references to earlier build stages. */
  function dockerfileBases(src: string): string[] {
    const stages = new Set<string>();
    const bases: string[] = [];
    for (const m of src.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gim)) {
      if (!stages.has(m[1].toLowerCase())) bases.push(m[1]);
      if (m[2]) stages.add(m[2].toLowerCase());
    }
    return bases;
  }

  const composeProd = read('docker-compose.prod.yml');
  const composeDev = read('docker-compose.yml');
  const workflowsDir = path.join(rootDir, '.github', 'workflows');
  const workflows = fs
    .readdirSync(workflowsDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ file: `.github/workflows/${f}`, src: read('.github', 'workflows', f) }));
  const dockerfiles = ['infra/backup/Dockerfile', 'apps/api/Dockerfile', 'apps/web/Dockerfile', 'apps/admin/Dockerfile'];

  describe('image pinning', () => {
    test('the exception list only names images that are really used', () => {
      const used = new Set([...imageRefs(composeProd), ...imageRefs(composeDev)]);
      for (const ref of Object.keys(UNPINNED_EXCEPTIONS)) expect(used).toContain(ref);
    });

    test.each([
      ['docker-compose.prod.yml', composeProd],
      ['docker-compose.yml', composeDev]
    ])('every image in %s is digest-pinned (or a justified exception)', (_file, src) => {
      const refs = imageRefs(src);
      expect(refs.length).toBeGreaterThan(0);
      const offenders = refs.filter((r) => !DIGEST_REF.test(r) && !(r in UNPINNED_EXCEPTIONS));
      expect(offenders).toEqual([]);
    });

    test('every image in the GitHub workflows is digest-pinned', () => {
      for (const { src } of workflows) {
        const offenders = imageRefs(src).filter((r) => !r.includes('${{') && !DIGEST_REF.test(r));
        expect(offenders).toEqual([]);
      }
    });

    test.each(dockerfiles)('every base image in %s is digest-pinned', (file) => {
      const bases = dockerfileBases(read(file));
      expect(bases.length).toBeGreaterThan(0);
      expect(bases.filter((b) => !DIGEST_REF.test(b))).toEqual([]);
    });

    test('the same image:tag resolves to the same digest everywhere', () => {
      const all = [
        ...imageRefs(composeProd),
        ...imageRefs(composeDev),
        ...workflows.flatMap((w) => imageRefs(w.src)),
        ...dockerfiles.flatMap((f) => dockerfileBases(read(f)))
      ].filter((r) => DIGEST_REF.test(r));
      const byTag = new Map<string, Set<string>>();
      for (const ref of all) {
        const [nameTag, digest] = ref.split('@');
        if (!byTag.has(nameTag)) byTag.set(nameTag, new Set());
        byTag.get(nameTag)!.add(digest);
      }
      for (const [nameTag, digests] of byTag) {
        expect({ image: nameTag, digests: [...digests] }).toEqual({ image: nameTag, digests: [[...digests][0]] });
      }
      // postgres is shared by compose, the backup image and CI: one digest for all
      expect(byTag.get('postgres:16-alpine')?.size).toBe(1);
    });

    test('nginx runs the 1.28 stable branch; 1.27 is gone', () => {
      const proxy = imageRefs(composeProd).filter((r) => r.startsWith('nginx:'));
      expect(proxy).toHaveLength(1);
      expect(proxy[0]).toMatch(/^nginx:1\.28-alpine@sha256:[0-9a-f]{64}$/);
      expect(composeProd).not.toMatch(/nginx:1\.27/);
    });

    test('Dependabot keeps docker-compose and Dockerfile digests current', () => {
      const dependabot = read('.github', 'dependabot.yml');
      expect(dependabot).toMatch(/package-ecosystem:\s*docker-compose\s*\n\s*directory:\s*\//);
      expect(dependabot).toMatch(/package-ecosystem:\s*docker\s*\n/);
      expect(dependabot).toContain('/infra/backup');
    });
  });

  describe('nginx', () => {
    const nginx = read('infra/nginx/nginx.conf');

    function serverBlock(serverName: string): string {
      const lines = nginx.split('\n');
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

    /** Body of the `location <spec> { ... }` block inside a server block. */
    function locationBlock(server: string, spec: string): string {
      const start = server.indexOf(`location ${spec} {`);
      expect(start).toBeGreaterThan(-1);
      return server.slice(start, server.indexOf('\n    }', start));
    }

    test('html_ssr rate-limit zone exists next to the existing auth zones', () => {
      expect(nginx).toMatch(/limit_req_zone \$binary_remote_addr zone=html_ssr:10m rate=20r\/s;/);
      for (const zone of ['api_general', 'api_auth', 'api_auth_recovery', 'api_auth_refresh']) {
        expect(nginx).toMatch(new RegExp(`limit_req_zone \\$binary_remote_addr zone=${zone}:`));
      }
    });

    test.each([
      ['www.gcdis.in', ['^~ /_next/static/', '^~ /_next/image', '^~ /images/']],
      ['admin.gcdis.in', ['^~ /_next/static/', '^~ /_next/image']]
    ])('%s: pages are rate limited, static assets are exempt', (host, staticLocations) => {
      const server = serverBlock(host);
      expect(locationBlock(server, '/')).toContain('limit_req zone=html_ssr burst=40 nodelay;');
      for (const loc of staticLocations) {
        const block = locationBlock(server, loc);
        expect(block).toContain('proxy_pass http://gcdis-');
        expect(block).not.toContain('limit_req');
      }
    });

    test('request body limits: 1M on www/admin, 10M API default, 25M only on uploads', () => {
      expect(nginx).toMatch(/^\s{2}client_max_body_size\s+10M;/m);
      expect(serverBlock('www.gcdis.in')).toMatch(/client_max_body_size 1M;/);
      expect(serverBlock('admin.gcdis.in')).toMatch(/client_max_body_size 1M;/);
      const api = serverBlock('api.gcdis.in');
      expect(locationBlock(api, '/api/uploads')).toContain('client_max_body_size 25M;');
      expect((nginx.match(/client_max_body_size 25M;/g) || []).length).toBe(1);
    });

    test('no version banner and no X-Powered-By', () => {
      expect(nginx).toMatch(/^\s*server_tokens off;/m);
      expect(read('infra/nginx/proxy-hide-headers.conf')).toMatch(/^proxy_hide_header X-Powered-By;/m);
      // the API block redeclares proxy_hide_header, so it must re-include the shared list
      expect(serverBlock('api.gcdis.in')).toContain('include /etc/nginx/proxy-hide-headers.conf;');
    });

    test('CORP is a fallback on www/admin (never duplicated with the app value)', () => {
      expect(nginx).toMatch(
        /map \$upstream_http_cross_origin_resource_policy \$gcdis_corp_fallback \{\s*""\s+"same-site";\s*default\s+"";\s*\}/
      );
      for (const host of ['www.gcdis.in', 'admin.gcdis.in']) {
        expect(serverBlock(host)).toContain('add_header Cross-Origin-Resource-Policy $gcdis_corp_fallback always;');
      }
      // hiding the upstream CORP would discard the app's (and the API's) own value
      expect(read('infra/nginx/proxy-hide-headers.conf')).not.toMatch(/^proxy_hide_header Cross-Origin-Resource-Policy/m);
      expect(read('infra/nginx/security-headers.conf')).not.toMatch(/^add_header Cross-Origin-Resource-Policy/m);
    });

    test('every add_header uses `always` (headers also on 4xx/5xx and 429)', () => {
      for (const file of ['nginx.conf', 'security-headers.conf', 'well-known.conf']) {
        const active = read('infra/nginx', file)
          .split('\n')
          .filter((l) => /^\s*add_header\b/.test(l));
        for (const line of active) expect(line).toMatch(/\balways;\s*$/);
      }
    });
  });

  describe('admin IP allow-list (prepared, disabled by default)', () => {
    const allowlist = read('infra/nginx/admin-allowlist.conf');

    test('has no active allow / deny rule', () => {
      const active = allowlist
        .split('\n')
        .map((l) => l.replace(/#.*$/, '').trim())
        .filter(Boolean);
      expect(active).toEqual([]);
    });

    test('documents how to enable it, in sync with ADMIN_IP_ALLOWLIST', () => {
      expect(allowlist).toMatch(/#\s+allow \S+;/);
      expect(allowlist).toMatch(/#\s+deny\s+all;/);
      expect(allowlist).toContain('ADMIN_IP_ALLOWLIST');
      expect(read('docs/security/production-checklist.md')).toContain('Admin IP allow-list go-live');
    });

    test('the API allow-list stays empty by default', () => {
      expect(composeProd).toContain('- ADMIN_IP_ALLOWLIST=${ADMIN_IP_ALLOWLIST:-}');
      expect(read('.env.example')).toMatch(/^ADMIN_IP_ALLOWLIST=""$/m);
    });
  });

  describe('docker-compose.prod.yml', () => {
    const doc = yaml.load(composeProd) as { services: Record<string, any> };
    const services = Object.entries(doc.services);

    test('every service rotates its json-file logs (10m x 5)', () => {
      expect(services.length).toBeGreaterThan(10);
      for (const [name, svc] of services) {
        expect({ name, logging: svc.logging }).toEqual({
          name,
          logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '5' } }
        });
      }
      expect(composeProd).toMatch(/^x-logging: &default-logging$/m);
    });

    test('api healthcheck fails on any non-2xx /api/health (503 when DB or Redis is down)', () => {
      const test = doc.services.api.healthcheck.test as string[];
      expect(test[0]).toBe('CMD');
      expect(test[1]).toBe('curl');
      // -f / --fail (possibly combined, e.g. -fsS) makes curl exit non-zero on HTTP >= 400
      expect(test.some((a) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a === '--fail')).toBe(true);
      expect(test[test.length - 1]).toBe('http://localhost:4000/api/health');
    });
  });
});

describe('API writable paths under the read-only root filesystem', () => {
  const read = (p: string) => require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8');

  test('the invoice/pass PDF cache lives on its own volume, so the API can boot read-only', () => {
    const compose = read('docker-compose.prod.yml');
    expect(compose).toContain('- PDF_CACHE_DIR=/app/apps/api/storage');
    expect(compose).toContain('- pdf_cache_data:/app/apps/api/storage');
    expect(compose).toMatch(/\n  pdf_cache_data:\n/);
    const dockerfile = read('apps/api/Dockerfile');
    expect(dockerfile).toContain('mkdir -p /app/apps/api/storage');
    const pdf = read('apps/api/src/certificates/pdf-generator.service.ts');
    expect(pdf).toContain('process.env.PDF_CACHE_DIR');
    // A non-writable cache directory must never crash the API at boot
    expect(pdf).toMatch(/try \{\s+if \(!fs\.existsSync\(this\.storageDir\)\)/);
  });

  test('SSR uses the internal API URL and deploys reload nginx', () => {
    expect(read('docker-compose.prod.yml')).toContain('- API_INTERNAL_URL=http://gcdis-api:4000/api');
    expect(read('scripts/deploy.sh')).toContain('dc exec -T proxy nginx -s reload');
  });
});
