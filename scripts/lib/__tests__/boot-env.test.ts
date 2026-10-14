import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REQUIRED_APP_ENV, validateRequiredBootEnv } from '../boot-env.mjs';

const env = {
  NODE_ENV: 'test' as const,
  IMAJIN_AUTH_URL: 'https://kernel.example.test',
  IMAJIN_KERNEL_URL: 'https://kernel.example.test',
  NEXT_PUBLIC_IMAJIN_APP_ID: 'app_under_test',
};

describe('check-env non-secret contract', () => {
  it('passes without any session credential in env', () => {
    expect(() => validateRequiredBootEnv(env)).not.toThrow();
    expect(REQUIRED_APP_ENV).not.toContain('SESSION_SECRET');
    expect(execFileSync(process.execPath, ['scripts/check-env.mjs'], {
      env, encoding: 'utf8',
    })).toContain('check-env: ok');
  });

  it('ignores extra env credentials without printing them', () => {
    const output = execFileSync(process.execPath, ['scripts/check-env.mjs'], {
      env: { ...env, SESSION_SECRET: 'FAKE_IGNORED_ENV_SESSION_FOR_TEST_ONLY' },
      encoding: 'utf8',
    });
    expect(output).not.toContain('FAKE_IGNORED_ENV_SESSION_FOR_TEST_ONLY');
  });

  it.each(REQUIRED_APP_ENV)('rejects empty %s by name only', (name) => {
    expect(() => validateRequiredBootEnv({ ...env, [name]: '   ' })).toThrow(name);
  });

  it('CLI exits 1 with every missing config name, not a vault credential requirement', () => {
    const result = spawnSync(process.execPath, ['scripts/check-env.mjs'], {
      env: { NODE_ENV: 'test' }, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(REQUIRED_APP_ENV.join(', '));
    expect(result.stderr).not.toContain('SESSION_SECRET');
  });
});
