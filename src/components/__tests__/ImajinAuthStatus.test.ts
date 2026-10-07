import { describe, expect, it } from 'vitest';
import { buildSignInUrl } from '../ImajinAuthStatus';

describe('buildSignInUrl', () => {
  it('builds the kernel authorize URL', () => {
    expect(buildSignInUrl('https://kernel.example.test', 'app_123')).toBe(
      'https://kernel.example.test/auth/authorize?app_id=app_123&scopes=profile:read',
    );
  });

  it('tolerates trailing slashes on the auth URL', () => {
    expect(buildSignInUrl('https://kernel.example.test//', 'app_123')).toBe(
      'https://kernel.example.test/auth/authorize?app_id=app_123&scopes=profile:read',
    );
  });

  it('url-encodes the app id', () => {
    expect(buildSignInUrl('https://kernel.example.test', 'a b&c')).toContain('app_id=a%20b%26c&');
  });

  it.each([
    ['empty auth URL', '', 'app_123'],
    ['whitespace-only auth URL', '   ', 'app_123'],
    ['slash-only auth URL', '/', 'app_123'],
    ['empty app id', 'https://kernel.example.test', ''],
  ])('returns null (no broken relative link) for %s', (_name, authUrl, appId) => {
    expect(buildSignInUrl(authUrl, appId)).toBeNull();
  });
});
