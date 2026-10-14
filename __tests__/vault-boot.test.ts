import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import {
  createSessionToken, generateBootstrapKeypair, verifySessionToken, writeKeystore,
  type AppVaultCredentials,
} from '@ima-jin/auth-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register, validateRequiredBootEnv } from '../instrumentation';
import { authConfig } from '@/lib/auth-config';
import { getSelfSecret, SelfSecretsUnavailableError } from '@/lib/self-secrets';
import { isAppClaimed, resetSigningIdentityForTests } from '@/lib/signing-identity';
import { GET as callback } from '../app/api/auth/callback/route';
import { GET as me } from '../app/api/me/route';
import manifest from '../imajin.app.json';

const { loadFromVaultMock, cookie } = vi.hoisted(() => ({
  loadFromVaultMock: vi.fn(),
  cookie: { value: '' },
}));

vi.mock('@ima-jin/auth-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ima-jin/auth-client')>(),
  loadFromVault: loadFromVaultMock,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => cookie.value ? { value: cookie.value } : undefined }),
}));

const appDid = 'did:imajin:app-under-test';
const userDid = 'did:imajin:test-user';
const fakeSession = 'FAKE_VAULT_SESSION_FOR_TEST_ONLY';
const fakeRotatedSession = 'FAKE_ROTATED_VAULT_SESSION_FOR_TEST_ONLY';
const fakeEnvSession = 'FAKE_IGNORED_ENV_SESSION_FOR_TEST_ONLY';
const user = {
  did: userDid,
  displayName: 'Test User',
  handle: 'test-user',
  attestationId: 'FAKE_TEST_ATTESTATION',
};

function credentials(value = fakeSession): AppVaultCredentials {
  return { values: { SESSION_SECRET: value }, degraded: [] };
}

describe('declared vault boot acceptance', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vault-boot-'));
    resetSigningIdentityForTests();
    cookie.value = '';
    loadFromVaultMock.mockReset().mockResolvedValue(credentials());
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('IMAJIN_APP_DID', appDid);
    vi.stubEnv('IMAJIN_AUTH_URL', 'https://kernel.example.test');
    vi.stubEnv('IMAJIN_KERNEL_URL', 'https://kernel.example.test');
    vi.stubEnv('NEXT_PUBLIC_IMAJIN_APP_ID', 'app_under_test');
    vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', '');
    vi.stubEnv('IMAJIN_APP_CLAIM_CODE', '');
    vi.stubEnv('IMAJIN_APP_KEYSTORE', join(dir, 'keystore.json'));
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      appDid,
      privateKey: 'FAKE_SIGNING_PRIVATE_KEY',
      publicKey: 'FAKE_SIGNING_PUBLIC_KEY',
      ...user,
    }), { status: 200 })));
  });

  afterEach(async () => {
    resetSigningIdentityForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function claimFixture() {
    writeKeystore(join(dir, 'keystore.json'), generateBootstrapKeypair());
  }

  it('boots with only non-secret config, signs a callback session, and serves the signed-in DID', async () => {
    claimFixture();
    const keystoreBefore = readFileSync(join(dir, 'keystore.json'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(validateRequiredBootEnv).not.toThrow();
    await register();
    expect(isAppClaimed()).toBe(true);
    expect(loadFromVaultMock).toHaveBeenCalledWith({
      appDid,
      kernelUrl: 'https://kernel.example.test',
      keystorePath: join(dir, 'keystore.json'),
      keys: [{ key: 'SESSION_SECRET', onMissing: 'fail' }],
      fetchOptions: { signal: expect.any(AbortSignal) },
    });

    const response = await callback(new NextRequest(
      `https://app.example.test/api/auth/callback?attestation_id=FAKE_TEST_ATTESTATION&user_did=${userDid}`
    ));
    cookie.value = response.cookies.get('imajin_session')!.value;
    expect(await verifySessionToken(cookie.value, { secret: fakeSession })).toMatchObject({ did: userDid });
    expect((await me()).status).toBe(200);
    expect(await (await me()).json()).toEqual({ did: userDid });
    expect(readFileSync(join(dir, 'keystore.json'))).toEqual(keystoreBefore);
    expect(process.env.SESSION_SECRET).toBe('');
    expect(log).not.toHaveBeenCalled();
  });

  it('ignores legacy env material and logs its name only, never either credential value', async () => {
    claimFixture();
    vi.stubEnv('SESSION_SECRET', fakeEnvSession);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await register();
    expect(authConfig.secret).toBe(fakeSession);
    const token = await createSessionToken(user, authConfig);
    expect(await verifySessionToken(token, { secret: fakeEnvSession })).toBeNull();
    expect(warning.mock.calls).toEqual([[
      'SESSION_SECRET ignored; issued by the kernel vault; delete it',
    ]]);
    expect(JSON.stringify([...warning.mock.calls, ...log.mock.calls])).not.toContain(fakeEnvSession);
    expect(JSON.stringify([...warning.mock.calls, ...log.mock.calls])).not.toContain(fakeSession);
    expect(process.env.SESSION_SECRET).toBe(fakeEnvSession);
  });

  it('does not become claimed or allow secret consumers before the asynchronous load resolves', async () => {
    claimFixture();
    let resolveLoad!: (value: AppVaultCredentials) => void;
    const pending = new Promise<AppVaultCredentials>((resolve) => { resolveLoad = resolve; });
    loadFromVaultMock.mockReturnValue(pending);
    const boot = register();
    await vi.waitFor(() => expect(loadFromVaultMock).toHaveBeenCalledTimes(1));
    expect(isAppClaimed()).toBe(false);
    expect(() => authConfig.secret).toThrow(SelfSecretsUnavailableError);
    resolveLoad(credentials());
    await boot;
    expect(isAppClaimed()).toBe(true);
    expect(authConfig.secret).toBe(fakeSession);
  });

  it('unclaimed boot skips the vault and keeps the session signer unavailable', async () => {
    await register();
    expect(loadFromVaultMock).not.toHaveBeenCalled();
    expect(isAppClaimed()).toBe(false);
    expect(() => authConfig.secret).toThrow(SelfSecretsUnavailableError);
  });

  it.each(['unreachable', 'missing', 'empty', 'whitespace'])(
    '%s vault state fails closed with one sanitized recovery line and exit(1), even with env material',
    async (failure) => {
      claimFixture();
      // Seed a previous generation to prove failure never retains old memory.
      await register();
      vi.stubEnv('SESSION_SECRET', fakeEnvSession);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('FAKE_TEST_PROCESS_EXIT');
      });
      if (failure === 'unreachable') {
        loadFromVaultMock.mockRejectedValue(new Error('FAKE_UNTRUSTED_PROVIDER_TEXT'));
      } else if (failure === 'missing') {
        loadFromVaultMock.mockResolvedValue({ values: {}, degraded: [] });
      } else {
        loadFromVaultMock.mockResolvedValue(credentials(failure === 'empty' ? '' : '   '));
      }
      await expect(register()).rejects.toThrow('FAKE_TEST_PROCESS_EXIT');
      expect(loadFromVaultMock).toHaveBeenCalledTimes(2);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(isAppClaimed()).toBe(false);
      expect(() => authConfig.secret).toThrow(SelfSecretsUnavailableError);
      expect(log.mock.calls).toEqual([[
        'Self-secret SESSION_SECRET unavailable. On /jin select Sync manifest secrets, ' +
        'sign the proposal, then restart this app; check kernel connectivity if re-sync fails.',
      ]]);
      const output = JSON.stringify([...warning.mock.calls, ...log.mock.calls]);
      for (const forbidden of [fakeEnvSession, fakeSession, 'FAKE_UNTRUSTED_PROVIDER_TEXT']) {
        expect(output).not.toContain(forbidden);
      }
    }
  );

  it('restart fetches the rotated value without editing files and invalidates the old cookie', async () => {
    claimFixture();
    const before = readFileSync(join(dir, 'keystore.json'));
    await register();
    const oldCookie = await createSessionToken(user, authConfig);
    loadFromVaultMock.mockResolvedValue(credentials(fakeRotatedSession));
    resetSigningIdentityForTests();
    await register();
    expect(loadFromVaultMock).toHaveBeenCalledTimes(2);
    expect(authConfig.secret).toBe(fakeRotatedSession);
    expect(await verifySessionToken(oldCookie, authConfig)).toBeNull();
    cookie.value = await createSessionToken(user, authConfig);
    expect(await (await me()).json()).toEqual({ did: userDid });
    expect(readFileSync(join(dir, 'keystore.json'))).toEqual(before);
    expect(process.env.SESSION_SECRET).toBe('');
  });

  it('shares vault memory across separately compiled module copies without an import-time env snapshot', async () => {
    claimFixture();
    await register();
    vi.resetModules();
    const otherBundle = await import('../src/lib/auth-config');
    expect(otherBundle.authConfig).not.toBe(authConfig);
    expect(otherBundle.authConfig.secret).toBe(fakeSession);
    resetSigningIdentityForTests();
    expect(() => otherBundle.authConfig.secret).toThrow();
  });

  it('loads every declared recipe and publishes none if a later declaration fails', async () => {
    claimFixture();
    manifest.secrets.push(
      { name: 'FAKE_SECOND_SECRET', kind: 'random-32B' },
      { name: 'FAKE_THIRD_SECRET', kind: 'random-32B' }
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('FAKE_TEST_PROCESS_EXIT'); });
    loadFromVaultMock.mockResolvedValueOnce(credentials())
      .mockRejectedValueOnce(new Error('FAKE_UNTRUSTED_PROVIDER_TEXT'));
    try {
      await expect(register()).rejects.toThrow('FAKE_TEST_PROCESS_EXIT');
      expect(loadFromVaultMock).toHaveBeenCalledTimes(2);
      expect(loadFromVaultMock.mock.calls[1][0].keys).toEqual([
        { key: 'FAKE_SECOND_SECRET', onMissing: 'fail' },
      ]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('FAKE_SECOND_SECRET');
      expect(() => getSelfSecret('SESSION_SECRET')).toThrow();
      expect(() => getSelfSecret('FAKE_SECOND_SECRET')).toThrow();
    } finally {
      manifest.secrets.pop();
      manifest.secrets.pop();
    }
  });

  it('declares only names/kinds, pins the public SDK, and removes the credential from the env contract', () => {
    expect(manifest).toEqual({ secrets: [{ name: 'SESSION_SECRET', kind: 'random-32B' }] });
    expect(readFileSync('.env.example', 'utf8')).not.toContain('SESSION_SECRET');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies['@ima-jin/auth']).toBe('0.8.18');
    expect(pkg.dependencies['@ima-jin/auth-client']).toBe('0.8.18');
    expect(readFileSync('instrumentation.ts', 'utf8')).not.toContain('SESSION_SECRET');
    const deploy = readFileSync('docs/DEPLOY.md', 'utf8');
    expect(deploy).toContain('ima-jin/imajin-ai#2801 first');
    expect(deploy).toContain('**before upgrading this app**');
  });
});
