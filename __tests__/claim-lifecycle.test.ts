import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register } from '../instrumentation';
import { middleware } from '../middleware';
import { POST } from '../app/api/claim/route';
import { GET } from '../app/api/health/route';
import { resetSigningIdentityForTests } from '@/lib/signing-identity';
import { resetClaimRateLimitForTests } from '@/lib/claim-rate-limit';

describe('browser-only claim lifecycle', () => {
  let workDir: string;
  const appDid = 'did:imajin:app-under-test';
  const browserCode = 'FAKE_BROWSER_CLAIM_CODE';

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'claim-lifecycle-'));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/test-app');
    vi.stubEnv('IMAJIN_AUTH_URL', 'https://kernel.example.test');
    vi.stubEnv('IMAJIN_KERNEL_URL', 'https://kernel.example.test');
    vi.stubEnv('SESSION_SECRET', 'FAKE_SESSION_SECRET_FOR_TEST_ONLY');
    vi.stubEnv('NEXT_PUBLIC_IMAJIN_APP_ID', 'app_under_test');
    vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', '');
    vi.stubEnv('IMAJIN_APP_DID', appDid);
    vi.stubEnv('IMAJIN_APP_KEYSTORE', join(workDir, 'keystore.json'));
    vi.stubEnv('IMAJIN_APP_CLAIM_CODE', 'FAKE_IGNORED_ENV_CLAIM_CODE');
  });

  afterEach(async () => {
    resetSigningIdentityForTests();
    resetClaimRateLimitForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  it('ignores env claiming at boot, goes live after browser submission without restart, and reboots from keystore', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      appDid,
      privateKey: 'FAKE_SIGNING_PRIVATE_KEY',
      publicKey: 'FAKE_SIGNING_PUBLIC_KEY',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const rootRequest = new NextRequest('http://localhost:3000/test-app', {
      nextConfig: { basePath: '/test-app' },
    });
    const claimRequest = new NextRequest('http://localhost:3000/test-app/claim', {
      nextConfig: { basePath: '/test-app' },
    });

    await register();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await GET().json()).toMatchObject({ claimed: false });
    expect(await middleware(rootRequest).text()).toContain('href="/test-app/claim"');
    expect(middleware(claimRequest).headers.get('x-middleware-next')).toBe('1');

    const response = await POST(new NextRequest('http://localhost:3000/test-app/api/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimCode: browserCode }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ appDid, publicKey: 'FAKE_SIGNING_PUBLIC_KEY' });
    const [claimUrl, claimInit] = fetchMock.mock.calls[0];
    expect(claimUrl).toBe('https://kernel.example.test/api/apps/claim');
    expect(JSON.parse(claimInit?.body as string).claimCode).toBe(browserCode);
    expect(await GET().json()).toMatchObject({ claimed: true });
    expect(middleware(rootRequest).headers.get('x-middleware-next')).toBe('1');
    expect(middleware(claimRequest).status).toBe(404);
    expect((await stat(join(workDir, 'keystore.json'))).mode & 0o777).toBe(0o600);
    expect(log).not.toHaveBeenCalled();

    resetSigningIdentityForTests();
    await register();
    const [bootUrl, bootInit] = fetchMock.mock.calls[1];
    expect(bootUrl).toBe('https://kernel.example.test/api/apps/signing-key/fetch');
    expect(JSON.parse(bootInit?.body as string).claimCode).toBeUndefined();
    expect(await GET().json()).toMatchObject({ claimed: true });
  });
});

it('has no legacy claim env variable in tracked runtime code, env contracts, scripts or docs', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = files
    .filter((path) => !path.includes('__tests__/'))
    .filter((path) => readFileSync(path, 'utf8').includes('IMAJIN_APP_CLAIM_CODE'));
  expect(hits).toEqual([]);
});
