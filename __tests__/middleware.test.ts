import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { readKeystoreMock, resolveKeystorePathMock } = vi.hoisted(() => ({
  readKeystoreMock: vi.fn(),
  resolveKeystorePathMock: vi.fn(() => '/tmp/keystore.json'),
}));

vi.mock('@ima-jin/auth-client', () => ({
  readKeystore: readKeystoreMock,
  resolveKeystorePath: resolveKeystorePathMock,
}));

function requestFor(path: string): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost:3000'));
}

describe('middleware', () => {
  afterEach(() => {
    readKeystoreMock.mockReset();
    resolveKeystorePathMock.mockClear();
  });

  it('serves the "not claimed yet" page for an ordinary route when unclaimed', async () => {
    readKeystoreMock.mockReturnValue(null);
    const { middleware } = await import('../middleware');

    const response = middleware(requestFor('/'));

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.toLowerCase()).toContain('not claimed yet');
  });

  it('passes /claim through when unclaimed', async () => {
    readKeystoreMock.mockReturnValue(null);
    const { middleware } = await import('../middleware');

    const response = middleware(requestFor('/claim'));

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('passes /api/health and /api/claim through when unclaimed', async () => {
    readKeystoreMock.mockReturnValue(null);
    const { middleware } = await import('../middleware');

    expect(middleware(requestFor('/api/health')).headers.get('x-middleware-next')).toBe('1');
    expect(middleware(requestFor('/api/claim')).headers.get('x-middleware-next')).toBe('1');
  });

  it('404s /claim once claimed', async () => {
    readKeystoreMock.mockReturnValue({ publicKey: 'pub', privateKey: 'priv' });
    const { middleware } = await import('../middleware');

    const response = middleware(requestFor('/claim'));

    expect(response.status).toBe(404);
  });

  it('404s /api/claim once claimed', async () => {
    readKeystoreMock.mockReturnValue({ publicKey: 'pub', privateKey: 'priv' });
    const { middleware } = await import('../middleware');

    const response = middleware(requestFor('/api/claim'));

    expect(response.status).toBe(404);
  });

  it('passes ordinary routes through once claimed', async () => {
    readKeystoreMock.mockReturnValue({ publicKey: 'pub', privateKey: 'priv' });
    const { middleware } = await import('../middleware');

    const response = middleware(requestFor('/'));

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
