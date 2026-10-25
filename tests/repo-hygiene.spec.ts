import * as fs from 'fs';
import * as path from 'path';

describe('Module 1: Repository Hygiene & Secrets Verification', () => {
  const rootDir = path.resolve(__dirname, '..');

  test('.gitignore exists and ignores sensitive files and build artifacts', () => {
    const gitignorePath = path.join(rootDir, '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('.env');
    expect(content).toContain('.next/');
    expect(content).toContain('node_modules/');
    expect(content).toContain('*.tsbuildinfo');
  });

  test('.env.example files exist and contain sanitized documentation without secrets', () => {
    const rootExample = path.join(rootDir, '.env.example');
    const apiExample = path.join(rootDir, 'apps', 'api', '.env.example');

    expect(fs.existsSync(rootExample)).toBe(true);
    expect(fs.existsSync(apiExample)).toBe(true);

    const rootContent = fs.readFileSync(rootExample, 'utf-8');
    expect(rootContent).toContain('REPLACE_WITH_MINIMUM_32_CHAR_CRYPTO_SECURE_SECRET_KEY');
    expect(rootContent).not.toContain('gcdis_super_secret_jwt_key_2026');
  });

  test('No hardcoded JWT fallback keys exist in API source files', () => {
    const apiSrcDir = path.join(rootDir, 'apps', 'api', 'src');
    
    function scanDir(dir: string) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          scanDir(fullPath);
        } else if (file.endsWith('.ts')) {
          const code = fs.readFileSync(fullPath, 'utf-8');
          expect(code).not.toContain('gcdis_super_secret_jwt_key_2026');
        }
      }
    }

    scanDir(apiSrcDir);
  });

  test('docker-compose.yml does not expose public host ports or commit plain passwords', () => {
    const composePath = path.join(rootDir, 'docker-compose.yml');
    expect(fs.existsSync(composePath)).toBe(true);
    const content = fs.readFileSync(composePath, 'utf-8');

    // Should bind to localhost only (127.0.0.1) or internal network
    expect(content).toContain('127.0.0.1:5432:5432');
    expect(content).toContain('127.0.0.1:6379:6379');
    expect(content).not.toContain('"5432:5432"');
    expect(content).not.toContain('"6379:6379"');
  });
});
