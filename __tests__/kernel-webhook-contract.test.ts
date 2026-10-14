import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

describe('kernel webhook template contract', () => {
  it('pins the published auth SDK and lockfile exactly to 0.8.18', () => {
    const { dependencies } = JSON.parse(read('package.json'));
    expect(dependencies['@ima-jin/auth']).toBe('0.8.18');
    expect(read('pnpm-lock.yaml')).toContain("'@ima-jin/auth':\n        specifier: 0.8.18");
  });

  it('has no shared callback credential or secret-generation guidance in operator surfaces', () => {
    const paths = [
      ...readdirSync(root).filter((name) => name.startsWith('.env') && name.endsWith('.example')),
      'README.md',
      ...readdirSync(`${root}docs`).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`),
      'api-spec/openapi.yaml',
      // Some forks add these; the template itself has neither.
      'scripts/lib/env-vars.json', 'scripts/check-env.mjs',
    ];
    for (const path of paths) {
      if (existsSync(`${root}${path}`)) {
        expect(read(path), path).not.toMatch(/WEBHOOK_SECRET|openssl\s+rand/i);
      }
    }
  });

  it('declares only public webhook configuration and documents handler wiring', () => {
    expect(read('.env.example')).toContain('AUTH_SERVICE_URL=');
    expect(read('.env.example')).toContain('IMAJIN_APP_DID=');
    expect(read('README.md')).toContain('handleKernelNotification');
    expect(read('README.md')).toContain('The expected audience');
    expect(read('docs/DEPLOY.md')).toContain('not restart-safe or shared across workers');
    expect(read('docs/DEPLOY.md')).toContain('data/kernel-webhook-pins/');
    expect(read('.gitignore')).toContain('data/kernel-webhook-pins/');
  });
});
