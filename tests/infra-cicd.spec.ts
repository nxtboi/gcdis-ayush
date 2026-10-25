import * as fs from 'fs';
import * as path from 'path';

describe('Production Infrastructure, Hardening & CI/CD Pipeline Verification', () => {
  const rootDir = path.resolve(__dirname, '..');

  test('1. Multi-stage Dockerfiles use pinned digest base images and non-root runners', () => {
    const apiDockerfile = fs.readFileSync(path.join(rootDir, 'apps', 'api', 'Dockerfile'), 'utf-8');
    const webDockerfile = fs.readFileSync(path.join(rootDir, 'apps', 'web', 'Dockerfile'), 'utf-8');
    const adminDockerfile = fs.readFileSync(path.join(rootDir, 'apps', 'admin', 'Dockerfile'), 'utf-8');

    // Digest pinning check
    expect(apiDockerfile).toMatch(/FROM node:22-alpine@sha256:/);
    expect(webDockerfile).toMatch(/FROM node:22-alpine@sha256:/);
    expect(adminDockerfile).toMatch(/FROM node:22-alpine@sha256:/);

    // Non-root compliance check
    expect(apiDockerfile).toContain('USER node');
    expect(webDockerfile).toContain('USER node');
    expect(adminDockerfile).toContain('USER node');

    // Web and Admin use standalone Next output
    expect(webDockerfile).toContain('.next/standalone');
    expect(adminDockerfile).toContain('.next/standalone');

    // Public directories copied
    expect(webDockerfile).toContain('apps/web/public');
    expect(adminDockerfile).toContain('apps/admin/public');

    // API has persistent volume
    expect(apiDockerfile).toContain('VOLUME ["/app/apps/api/uploads", "/app/apps/api/storage"]');
  });

  test('2. docker-compose.prod.yml restricts database ports, enforces separate roles, requirepass & resource limits', () => {
    const prodCompose = fs.readFileSync(path.join(rootDir, 'docker-compose.prod.yml'), 'utf-8');

    // Zero host ports on sensitive infrastructure
    expect(prodCompose).not.toContain('"5432:5432"');
    expect(prodCompose).not.toContain('"6379:6379"');

    // Required security variables
    expect(prodCompose).toContain('COOKIE_SECRET');
    expect(prodCompose).toContain('SUPER_ADMIN_EMAIL');
    expect(prodCompose).toContain('SUPER_ADMIN_TEMP_PASSWORD');
    expect(prodCompose).toContain('requirepass');
    expect(prodCompose).toContain('init-roles.sh');

    // SSL bootstrap and healthchecks
    expect(prodCompose).toContain('cert_init');
    expect(prodCompose).toContain('healthcheck');
    expect(prodCompose).toContain('resources');
  });

  test('3. Nginx repeats all security headers, enforces CSP, real IP handling, and rate limits', () => {
    const nginxDir = path.join(rootDir, 'infra', 'nginx');
    const nginxContent = ['nginx.conf', 'security-headers.conf', 'proxy-params.conf']
      .map((f) => fs.readFileSync(path.join(nginxDir, f), 'utf-8'))
      .join('\n');

    // Real client IP handling: nginx is the edge, so it must not trust client-supplied X-Forwarded-For
    expect(nginxContent).not.toMatch(/^\s*set_real_ip_from/m);
    expect(nginxContent).toContain('X-Forwarded-For $remote_addr');
    expect(nginxContent).toContain('include /etc/nginx/security-headers.conf');

    // Rate limiting zones
    expect(nginxContent).toContain('limit_req_zone');
    expect(nginxContent).toContain('limit_conn_zone');

    // Security headers repeated in every server block
    expect(nginxContent).toContain('Strict-Transport-Security');
    expect(nginxContent).toContain('Content-Security-Policy');
    expect(nginxContent).toContain('X-Robots-Tag');
    expect(nginxContent).toContain('client_max_body_size 25M');
  });

  test('4. CI/CD pipeline enforces Gitleaks, high+ prod audit, all 4 workspaces typecheck, and rollback', () => {
    const workflow = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'ci-cd.yml'), 'utf-8');

    expect(workflow).toContain('gitleaks/gitleaks-action');
    expect(workflow).toContain('npm audit --omit=dev --audit-level=high');
    expect(workflow).toContain('packages/shared');
    expect(workflow).toContain('apps/api');
    expect(workflow).toContain('apps/web');
    expect(workflow).toContain('apps/admin');
    expect(workflow).toContain('Automated Rollback');
  });
});
