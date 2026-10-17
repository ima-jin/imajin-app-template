import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuildInfo } from '../src/components/BuildInfo';
import { getBuildInfo } from '../src/lib/build-info';
import { GET } from '../app/api/build/route';

afterEach(() => vi.unstubAllEnvs());

describe('public build provenance', () => {
  it('returns the same immutable values as the footer and links to this app, not the kernel', async () => {
    const sha = 'a1b2c3d'.padEnd(40, '0');
    vi.stubEnv('NEXT_PUBLIC_VERSION', '0.1.0');
    vi.stubEnv('NEXT_PUBLIC_BUILD_HASH', sha);
    vi.stubEnv('NEXT_PUBLIC_SOURCE_REPO', 'derived/app');
    vi.stubEnv('NEXT_PUBLIC_BUILD_TIME', '2026-10-17T12:00:00.000Z');
    const response = GET();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(getBuildInfo());
    const html = renderToStaticMarkup(createElement(BuildInfo, { appName: 'My App' }));
    expect(html).toContain('My App');
    expect(html).toContain('v0.1.0');
    expect(html).toContain(' · build ');
    expect(html).toContain('>a1b2c3d</a>');
    expect(html).toContain(`href="https://github.com/derived/app/commit/${sha}"`);
    expect(html).toContain('href="https://github.com/derived/app/releases/tag/v0.1.0"');
    expect(html).toContain(`aria-label="Source commit ${sha}"`);
  });

  it('does not create a fake commit link for local builds or a missing repository', () => {
    for (const name of ['NEXT_PUBLIC_VERSION', 'NEXT_PUBLIC_BUILD_HASH', 'NEXT_PUBLIC_SOURCE_REPO', 'NEXT_PUBLIC_BUILD_TIME']) {
      vi.stubEnv(name, '');
    }
    expect(getBuildInfo()).toEqual({ version: 'dev', sha: 'local', repo: '', builtAt: '' });
    expect(renderToStaticMarkup(createElement(BuildInfo, { appName: 'My App' }))).not.toContain('<a');
    vi.stubEnv('NEXT_PUBLIC_VERSION', '0.1.0');
    vi.stubEnv('NEXT_PUBLIC_SOURCE_REPO', 'owner/app');
    const html = renderToStaticMarkup(createElement(BuildInfo, { appName: 'My App' }));
    expect(html).toContain('local');
    expect(html).not.toContain('/commit/');
  });
});
