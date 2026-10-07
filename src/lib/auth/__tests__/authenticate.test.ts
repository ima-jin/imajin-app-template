import { beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../../../../package.json';

const { requireSessionOrAppTokenMock } = vi.hoisted(() => ({ requireSessionOrAppTokenMock: vi.fn() }));

vi.mock('@ima-jin/auth', () => ({
  requireSessionOrAppToken: requireSessionOrAppTokenMock,
}));

describe('authenticate', () => {
  beforeEach(() => {
    requireSessionOrAppTokenMock.mockReset();
  });

  it("scopes the audience to this app's registry slug (package name), never its host (imajin-ai#2706)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://dev-jin.imajin.ai/my-app';
    requireSessionOrAppTokenMock.mockResolvedValue({ auth: { did: 'did:imajin:caller', scopes: [], via: 'token' } });
    const { authenticate } = await import('../authenticate');

    const request = new Request('https://dev-jin.imajin.ai/my-app/api/thing');
    const result = await authenticate(request);

    expect(requireSessionOrAppTokenMock).toHaveBeenCalledWith(request, { slug: pkg.name, requireScopes: undefined });
    const options = requireSessionOrAppTokenMock.mock.calls[0][1] as Record<string, unknown>;
    expect(options).not.toHaveProperty('aud');
    expect('auth' in result && result.auth.did).toBe('did:imajin:caller');
  });

  it('forwards a failure as { error, status }', async () => {
    requireSessionOrAppTokenMock.mockResolvedValue({ error: 'Invalid or expired app token for this app', status: 401 });
    const { authenticate } = await import('../authenticate');

    const result = await authenticate(new Request('https://dev-jin.imajin.ai/x'));

    expect(result).toEqual({ error: 'Invalid or expired app token for this app', status: 401 });
  });

  it('forwards requireScopes through to the underlying check', async () => {
    requireSessionOrAppTokenMock.mockResolvedValue({ error: 'Missing required scope(s): app:write', status: 403 });
    const { authenticate } = await import('../authenticate');

    await authenticate(new Request('https://dev-jin.imajin.ai/x'), { requireScopes: ['app:write'] });

    expect(requireSessionOrAppTokenMock).toHaveBeenCalledWith(expect.anything(), {
      slug: pkg.name,
      requireScopes: ['app:write'],
    });
  });
});
