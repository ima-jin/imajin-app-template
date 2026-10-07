import { afterEach, describe, expect, it, vi } from 'vitest';

const { bootstrapSigningIdentityMock } = vi.hoisted(() => ({
  bootstrapSigningIdentityMock: vi.fn(),
}));

vi.mock('@/lib/signing-identity', () => ({
  bootstrapSigningIdentity: bootstrapSigningIdentityMock,
}));

describe('validateSigningKeyBootEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    bootstrapSigningIdentityMock.mockReset();
  });

  it('fails loud when a raw private key is still set, pointing at the new flow', async () => {
    vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', 'raw-key-that-should-not-be-here');
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:app-under-test');
    const { validateSigningKeyBootEnv } = await import('../instrumentation');

    expect(() => validateSigningKeyBootEnv()).toThrow(/IMAJIN_APP_PRIVATE_KEY/);
    expect(() => validateSigningKeyBootEnv()).toThrow(/loadAppSigningKey/);
  });

  it('fails loud when IMAJIN_APP_DID is not set', async () => {
    vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', '');
    vi.stubEnv('IMAJIN_APP_DID', '');
    const { validateSigningKeyBootEnv } = await import('../instrumentation');

    expect(() => validateSigningKeyBootEnv()).toThrow(/IMAJIN_APP_DID is not set/);
  });

  it('passes when neither guard trips', async () => {
    vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', '');
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:app-under-test');
    const { validateSigningKeyBootEnv } = await import('../instrumentation');

    expect(() => validateSigningKeyBootEnv()).not.toThrow();
  });
});

describe('validateRequiredBootEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubValidEnv() {
    vi.stubEnv('IMAJIN_AUTH_URL', 'https://kernel.example.test');
    vi.stubEnv('SESSION_SECRET', 'session-secret-under-test');
    vi.stubEnv('NEXT_PUBLIC_IMAJIN_APP_ID', 'app_under_test');
  }

  it('passes when every required variable is set', async () => {
    stubValidEnv();
    const { validateRequiredBootEnv } = await import('../instrumentation');

    expect(() => validateRequiredBootEnv()).not.toThrow();
  });

  it.each(['IMAJIN_AUTH_URL', 'SESSION_SECRET', 'NEXT_PUBLIC_IMAJIN_APP_ID'])(
    'throws naming %s when it is empty',
    async (name) => {
      stubValidEnv();
      vi.stubEnv(name, '');
      const { validateRequiredBootEnv } = await import('../instrumentation');

      expect(() => validateRequiredBootEnv()).toThrow(new RegExp(`\\b${name}\\b`));
    }
  );

  it('treats a whitespace-only value as missing', async () => {
    stubValidEnv();
    vi.stubEnv('SESSION_SECRET', '   ');
    const { validateRequiredBootEnv } = await import('../instrumentation');

    expect(() => validateRequiredBootEnv()).toThrow(/SESSION_SECRET/);
  });

  it('reports every missing variable in one error', async () => {
    vi.stubEnv('IMAJIN_AUTH_URL', '');
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('NEXT_PUBLIC_IMAJIN_APP_ID', '');
    const { validateRequiredBootEnv } = await import('../instrumentation');

    expect(() => validateRequiredBootEnv()).toThrow(
      /IMAJIN_AUTH_URL, SESSION_SECRET, NEXT_PUBLIC_IMAJIN_APP_ID/
    );
  });
});

describe('register', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    bootstrapSigningIdentityMock.mockReset();
  });

  it('skips validation and bootstrap outside the nodejs runtime (e.g. edge)', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const { register } = await import('../instrumentation');

    await expect(register()).resolves.toBeUndefined();
    expect(bootstrapSigningIdentityMock).not.toHaveBeenCalled();
  });

  it('bootstraps the signing identity once the boot env is valid', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('IMAJIN_AUTH_URL', 'https://kernel.example.test');
    vi.stubEnv('SESSION_SECRET', 'session-secret-under-test');
    vi.stubEnv('NEXT_PUBLIC_IMAJIN_APP_ID', 'app_under_test');
    vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', '');
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:app-under-test');
    bootstrapSigningIdentityMock.mockResolvedValue(undefined);
    const { register } = await import('../instrumentation');

    await register();

    expect(bootstrapSigningIdentityMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to boot, before bootstrapping, when required env is missing', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('IMAJIN_AUTH_URL', '');
    vi.stubEnv('SESSION_SECRET', 'session-secret-under-test');
    vi.stubEnv('NEXT_PUBLIC_IMAJIN_APP_ID', 'app_under_test');
    vi.stubEnv('IMAJIN_APP_PRIVATE_KEY', '');
    vi.stubEnv('IMAJIN_APP_DID', 'did:imajin:app-under-test');
    const { register } = await import('../instrumentation');

    await expect(register()).rejects.toThrow(/IMAJIN_AUTH_URL/);
    expect(bootstrapSigningIdentityMock).not.toHaveBeenCalled();
  });
});
