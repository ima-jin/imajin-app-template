import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalKernelWebhookPayload } from '@ima-jin/auth/kernel-webhook';
import * as handler from '@/lib/kernel-notification';
import { POST } from '../route';

// Ephemeral keys generated only in-test; the published SDK is not mocked.
const signingKey = generateKeyPairSync('ed25519');
const foreignKey = generateKeyPairSync('ed25519');
function publicDocument(key: typeof signingKey) {
  const publicKey = key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const kid = `auth-${createHash('sha256').update(publicKey).digest('hex').slice(0, 16)}`;
  return { kid, publicKey, algorithm: 'Ed25519', validFrom: new Date(0).toISOString() };
}
const key = publicDocument(signingKey);
const audience = 'did:imajin:template-test';
const callbackUrl = 'https://app.test/example/api/webhooks/kernel';
const directory = mkdtempSync(join(tmpdir(), 'template-kernel-webhook-'));
const pins = join(directory, 'data', 'kernel-webhook-pins');
const discovery = vi.fn();
let processed: ReturnType<typeof vi.spyOn>;

function signedRequest(body: unknown = { type: 'example.notification' }, options: {
  audience?: string;
  offset?: number;
  privateKey?: typeof signingKey.privateKey;
} = {}): Request {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000) + (options.offset ?? 0));
  const nonce = randomUUID();
  const recipient = options.audience ?? audience;
  const payload = canonicalKernelWebhookPayload({
    audience: recipient, timestamp, nonce, method: 'POST', url: callbackUrl, rawBody,
  });
  return new Request(callbackUrl, {
    method: 'POST',
    body: rawBody,
    headers: {
      'content-type': 'application/json',
      'x-kernel-audience': recipient,
      'x-kernel-timestamp': timestamp,
      'x-kernel-nonce': nonce,
      'x-kernel-kid': key.kid,
      'x-kernel-signature': sign(null, Buffer.from(payload), options.privateKey ?? signingKey.privateKey).toString('hex'),
    },
  });
}

async function expectRejected(request: Request, status = 401) {
  const response = await POST(request);
  expect(response.status).toBe(status);
  expect(processed).not.toHaveBeenCalled();
  return response;
}

beforeAll(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  mkdirSync(pins, { recursive: true });
});
beforeEach(() => {
  processed = vi.spyOn(handler, 'handleKernelNotification');
  vi.stubEnv('IMAJIN_APP_DID', audience);
  // Fresh namespace per case: test failures must not hide behind cached discovery.
  vi.stubEnv('AUTH_SERVICE_URL', `https://${randomUUID()}.kernel.test/auth`);
  discovery.mockReset().mockImplementation(async () => Response.json({ current: key.kid, keys: [key] }));
  vi.stubGlobal('fetch', discovery);
});
afterEach(() => {
  processed.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe('POST /api/webhooks/kernel', () => {
  it('accepts a kernel-signed notification without a shared credential and hands parsed JSON to the stub', async () => {
    const payload = { type: 'example.notification', exampleId: 'fake-example-id' };
    const response = await POST(signedRequest(payload));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(processed).toHaveBeenCalledOnce();
    expect(processed).toHaveBeenCalledWith(payload);
    expect(discovery).toHaveBeenCalledWith(
      `${process.env.AUTH_SERVICE_URL}/.well-known/kernel-signing-key`, expect.any(Object),
    );
  });

  it('rejects a replay without repeating handler effects', async () => {
    const request = signedRequest();
    const replay = request.clone();
    expect((await POST(request)).status).toBe(200);
    processed.mockClear();
    await expectRejected(replay);
  });

  it.each([
    ['stale', { offset: -301 }],
    ['future', { offset: 301 }],
    ['wrong audience', { audience: 'did:imajin:another-app' }],
    ['wrong key', { privateKey: foreignKey.privateKey }],
  ])('rejects %s notifications', async (_label, options) => {
    await expectRejected(signedRequest(undefined, options));
  });

  it.each([undefined, 'Bearer FAKE_LEGACY_PLACEHOLDER'])('rejects unsigned notifications, even with %s', async (authorization) => {
    const headers = new Headers();
    if (authorization) headers.set('authorization', authorization);
    await expectRejected(new Request(callbackUrl, { method: 'POST', headers, body: 'not json' }));
  });

  it.each([
    ['body', { body: '{ "type": "example.notification" }' }],
    ['path', { url: 'https://app.test/api/webhooks/kernel' }],
    ['query', { url: `${callbackUrl}?tampered=true` }],
    ['method', { method: 'PUT' }],
  ])('rejects tampered %s', async (_label, changes: { url?: string; method?: string; body?: string }) => {
    const request = signedRequest();
    await expectRejected(new Request(changes.url ?? request.url, {
      method: changes.method ?? request.method, headers: request.headers,
      body: changes.body ?? JSON.stringify({ type: 'example.notification' }),
    }));
  });

  it.each(['x-kernel-audience', 'x-kernel-timestamp', 'x-kernel-nonce', 'x-kernel-kid', 'x-kernel-signature'])(
    'rejects a missing %s header', async (header) => {
      const request = signedRequest();
      request.headers.delete(header);
      await expectRejected(request);
    },
  );

  it.each([
    ['x-kernel-audience', 'did:imajin:another-app'],
    ['x-kernel-timestamp', String(Math.floor(Date.now() / 1000) - 10)],
    ['x-kernel-nonce', randomUUID()],
    ['x-kernel-kid', `auth-${'0'.repeat(16)}`],
    ['x-kernel-signature', '0'.repeat(128)],
    ['x-kernel-signature', 'malformed'],
  ])('rejects an altered %s header', async (header, value) => {
    const request = signedRequest();
    request.headers.set(header, value);
    await expectRejected(request);
  });

  it.each(['', 'not-a-did'])('fails closed with invalid local audience %s', async (value) => {
    vi.stubEnv('IMAJIN_APP_DID', value);
    await expectRejected(signedRequest());
  });

  it('returns 400 only after verifying signed non-JSON', async () => {
    await expectRejected(signedRequest('not json'), 400);
  });

  it('returns 503 without exposing discovery errors', async () => {
    discovery.mockRejectedValue(new Error('internal discovery details'));
    const response = await expectRejected(signedRequest(), 503);
    expect(await response.json()).toEqual({ error: 'Webhook verification unavailable' });
  });

  it('returns 503 for a non-overlapping public trust pin', async () => {
    const namespace = process.env.AUTH_SERVICE_URL!;
    const path = join(pins, `${createHash('sha256').update(namespace).digest('hex')}.json`);
    writeFileSync(path, JSON.stringify([publicDocument(foreignKey)]));
    await expectRejected(signedRequest(), 503);
  });

  it('returns 503 for failed pin storage', async () => {
    const namespace = process.env.AUTH_SERVICE_URL!;
    const path = join(pins, `${createHash('sha256').update(namespace).digest('hex')}.json`);
    mkdirSync(path);
    await expectRejected(signedRequest(), 503);
  });

  it('returns a sanitized 500 when the verified business handler fails', async () => {
    processed.mockImplementationOnce(() => { throw new Error('internal handler details'); });
    const response = await POST(signedRequest());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Webhook handler failed' });
    expect(processed).toHaveBeenCalledOnce();
  });
});
