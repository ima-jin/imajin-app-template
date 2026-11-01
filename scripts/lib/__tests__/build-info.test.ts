import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { computeBuildInfo, repositoryFromRemote, sourceRepository } from '../build-info.mjs';
import { gitOutput, latestTagVersion, resolveGitBinary } from '../git-version.mjs';

const git = resolveGitBinary();
const now = new Date('2026-10-17T12:00:00Z');
function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'build-info-'));
  // Reuse existing history: tests must not invent or override a git identity.
  gitOutput(git, root, ['clone', '--shared', '--no-checkout', '--no-tags', process.cwd(), '.']);
  gitOutput(git, root, ['remote', 'set-url', 'origin', 'git@github.com:owner/app.git']);
  return root;
}

afterEach(() => vi.unstubAllEnvs());

describe('kernel tag version port', () => {
  it('selects the nearest reachable version tag, ignoring a later marker', () => {
    const root = checkout();
    gitOutput(git, root, ['tag', 'v0.2.0', 'HEAD^']);
    gitOutput(git, root, ['tag', 'checkpoint']);
    const sha = gitOutput(git, root, ['rev-parse', 'HEAD']);
    expect(latestTagVersion(git, root)).toBe('0.2.0');
    expect(computeBuildInfo(root, '0.1.0', {}, now)).toEqual({
      version: '0.2.0', sha, repo: 'owner/app', builtAt: now.toISOString(),
    });
  });

  it('uses package version and local when no release tag exists', () => {
    const root = checkout();
    gitOutput(git, root, ['tag', 'latest']);
    expect(computeBuildInfo(root, '0.1.0', {}, now)).toEqual({
      version: '0.1.0', sha: 'local', repo: 'owner/app', builtAt: now.toISOString(),
    });
  });

  it('supports tarballs and missing git without aborting', () => {
    const root = mkdtempSync(join(tmpdir(), 'tarball-'));
    expect(computeBuildInfo(root, '0.1.0', {}, now)).toEqual({
      version: '0.1.0', sha: 'local', repo: '', builtAt: now.toISOString(),
    });
    vi.stubEnv('GIT_BIN', '/not-installed/git');
    expect(computeBuildInfo(root, '', {}, now).version).toBe('dev');
  });

  it('preserves explicit public artifact inputs even without git', () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-'));
    const env = {
      NEXT_PUBLIC_VERSION: '1.2.3',
      NEXT_PUBLIC_BUILD_HASH: 'abc1234',
      NEXT_PUBLIC_SOURCE_REPO: 'derived/app',
      NEXT_PUBLIC_BUILD_TIME: now.toISOString(),
    };
    expect(computeBuildInfo(root, '0.1.0', env)).toEqual({
      version: '1.2.3', sha: 'abc1234', repo: 'derived/app', builtAt: now.toISOString(),
    });
  });

  it('works without a remote and accepts an absolute git override', () => {
    const root = checkout();
    gitOutput(git, root, ['tag', 'v1.0.0']);
    gitOutput(git, root, ['remote', 'remove', 'origin']);
    vi.stubEnv('GIT_BIN', git);
    expect(resolveGitBinary()).toBe(git);
    expect(computeBuildInfo(root, '0.1.0', {}, now)).toMatchObject({ version: '1.0.0', repo: '' });
    vi.stubEnv('GIT_BIN', 'relative/git');
    expect(resolveGitBinary()).toMatch(/^\//);
  });
});

describe('source repository', () => {
  it.each([
    'https://github.com/owner/app.git', 'git@github.com:owner/app.git', 'ssh://git@github.com/owner/app',
  ])('extracts owner/name from %s', (remote) => {
    expect(repositoryFromRemote(remote)).toBe('owner/app');
  });
  it.each(['https://user:secret@github.com/owner/app', 'https://evil.test/owner/app', '/local/path', ''])(
    'never exposes credentials or non-GitHub remotes: %s', (remote) => {
      expect(repositoryFromRemote(remote)).toBe('');
    },
  );
  it('accepts only owner/name public overrides', () => {
    expect(sourceRepository(' owner/app.git ')).toBe('owner/app');
    expect(sourceRepository('javascript:alert(1)')).toBe('');
    expect(sourceRepository()).toBe('');
  });
});
