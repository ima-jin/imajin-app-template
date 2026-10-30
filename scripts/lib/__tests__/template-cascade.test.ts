import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  branchFor, discoverApps, dryRun, keepAppSection, pullBody, summary, validateApps,
} from '../template-cascade.mjs';
import { gitRunner, isAncestor, mergeTemplate } from '../template-cascade-git.mjs';

const app = { sourceRepo: 'ima-jin/coffee', templateRef: null, joined: true };
const section = '## 8. This App\nApp scope stays here.  \n\n';

describe('cascade discovery and planning', () => {
  it('plans all seven fallback repos, including the other organization, without credentials', async () => {
    const apps = await discoverApps({});
    expect(apps).toHaveLength(7);
    expect(dryRun(apps, 'v1.0.0')).toContain('gbscontracting/website: PR chore/sync-from-template-v1.0.0 -> main');
    expect(dryRun([{ ...app, joined: false }], 'v1')).toContain('one-time join issue');
  });
  it('uses the configured registry and never sends credentials or follows redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => [app] });
    expect(await discoverApps({ registryUrl: 'https://registry.example/apps?template=x', fetcher }))
      .toEqual([{ ...app, owner: 'ima-jin' }]);
    expect(fetcher.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal), redirect: 'error' });
    await expect(discoverApps({ registryUrl: 'http://registry.example', fetcher })).rejects.toThrow('HTTPS');
    await expect(discoverApps({ registryUrl: 'https://user:pass@registry.example', fetcher })).rejects.toThrow('HTTPS');
  });
  it('fails closed on registry errors or malformed responses', async () => {
    await expect(discoverApps({
      registryUrl: 'https://registry.example', fetcher: async () => new Response('', { status: 503 }),
    })).rejects.toThrow('503');
    await expect(discoverApps({
      registryUrl: 'https://registry.example', fetcher: async () => { throw new Error('offline'); },
    })).rejects.toThrow('offline');
    expect(validateApps({ apps: [app] })).toHaveLength(1);
    for (const payload of [{}, [], [app, app], [{ ...app, joined: 'true' }],
      [{ ...app, sourceRepo: 'ima-jin/imajin-app-template' }], [{ ...app, sourceRepo: '../bad' }],
      [{ ...app, templateRef: '--upload-pack=bad' }], Array(257).fill(app)]) {
      expect(() => validateApps(payload)).toThrow();
    }
  });
  it('rejects unsafe tags without lossy sanitization collisions', () => {
    expect(branchFor('v1.2.3-rc.1')).toBe('chore/sync-from-template-v1.2.3-rc.1');
    for (const tag of ['', 'main', 'v1/foo', 'v1..2', 'v1.lock', 'v$(id)']) {
      expect(() => branchFor(tag)).toThrow();
    }
  });
  it('preserves app section byte-for-byte and rejects missing boundaries', () => {
    expect(keepAppSection('Shared new\n## 8. This App\nplaceholder\n', `Old\n${section}`))
      .toBe(`Shared new\n${section}`);
    expect(() => keepAppSection('missing', section)).toThrow('§8');
    expect(() => keepAppSection(section, 'missing')).toThrow('§8');
  });
  it('renders changelog, conflict paths, operator hook and result lines', () => {
    const body = pullBody({ tag: 'v1', sha: 'abc', changelog: '- change', conflicts: ['README.md'] });
    expect(body).toContain('`README.md`');
    expect(body).toContain('template-sync-conflict');
    expect(body).toContain('- change');
    expect(pullBody({ tag: 'v1', sha: 'abc', conflicts: [] })).toContain('Clean merge');
    expect(summary([{ sourceRepo: 'a/b', status: 'failed', detail: 'reason' },
      { sourceRepo: 'a/c', status: 'PR', url: 'https://example.test/pr' }], 'v1'))
      .toContain('a/b: failed — reason');
  });
});

function fixture(conflict = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'cascade-test-'));
  const git = gitRunner(cwd);
  git('init', '-b', 'main', '--quiet');
  writeFileSync(join(cwd, 'AGENTS.md'), `Shared old\n## 8. This App\nplaceholder\n`);
  writeFileSync(join(cwd, 'shell.txt'), 'base\n');
  git('add', '.');
  fixtureCommit(cwd, 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'template');
  writeFileSync(join(cwd, 'AGENTS.md'), 'Shared new\n## 8. This App\nnew placeholder\n');
  writeFileSync(join(cwd, 'shell.txt'), 'template\n');
  git('add', '-A');
  fixtureCommit(cwd, 'update shell');
  const sha = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  writeFileSync(join(cwd, 'AGENTS.md'), `Shared old\n${section}`);
  if (conflict) writeFileSync(join(cwd, 'shell.txt'), 'app\n');
  git('add', '-A');
  fixtureCommit(cwd, 'app scope');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const main = git('rev-parse', 'HEAD');
  git('checkout', '-qb', branchFor('v1'));
  return { cwd, git, sha, base, main };
}

// Synthetic Git objects, not runtime identity overrides. The fixture works
// without any configured developer identity on the test runner.
function fixtureCommit(cwd: string, message: string, mergeParent?: string) {
  const git = gitRunner(cwd);
  let parents = '';
  try { parents = `parent ${git('rev-parse', '--verify', 'HEAD')}\n`; } catch { /* root fixture */ }
  if (mergeParent) parents += `parent ${mergeParent}\n`;
  const identity = 'Fixture <fixture@example.invalid> 1700000000 +0000';
  const object = `tree ${git('write-tree')}\n${parents}author ${identity}\ncommitter ${identity}\n\n${message}\n`;
  const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd, input: object, encoding: 'utf8',
  }).trim();
  git('reset', '--hard', sha);
}

describe('real local git merges (no remote writes)', () => {
  it.each([false, true])('preserves §8 and app main, records merge ancestry, conflict=%s', conflict => {
    const { cwd, git, sha, base, main } = fixture(conflict);
    const commit = (_runner: unknown, message: string, parent: string) => fixtureCommit(cwd, message, parent);
    const result = mergeTemplate({ cwd, sha, tag: 'v1', templateRef: base, commit });
    expect(result.conflicts).toEqual(conflict ? ['shell.txt'] : []);
    expect(result.changelog).toContain('update shell');
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe(`Shared new\n${section}`);
    expect(git('rev-parse', 'origin/main')).toBe(main);
    expect(git('rev-parse', 'main')).toBe(main);
    expect(isAncestor(git, sha, 'HEAD')).toBe(true);
    expect(isAncestor(git, 'HEAD', 'origin/main')).toBe(false);
    expect(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    expect(mergeTemplate({ cwd, sha, tag: 'v1' })).toMatchObject({ changed: false, conflicts: result.conflicts });
    if (conflict) expect(readFileSync(join(cwd, 'shell.txt'), 'utf8')).toContain('<<<<<<<');
  });
  it('allows an injected App-attributed commit and fails on an ahead-of-template ref', () => {
    const { cwd, sha, main } = fixture();
    expect(() => mergeTemplate({ cwd, sha, tag: 'v1', templateRef: main })).toThrow('ancestor');
    const commit = vi.fn((_runner: unknown, message: string, parent: string) => fixtureCommit(cwd, message, parent));
    mergeTemplate({ cwd, sha, tag: 'v1', commit });
    expect(commit).toHaveBeenCalledOnce();
  });
  it('propagates unexpected Git failures', () => {
    expect(() => isAncestor(() => { throw Object.assign(new Error('fatal'), { status: 128 }); }, 'a', 'b'))
      .toThrow('fatal');
  });
  it('runs the dry-run CLI end to end without GH_TOKEN or any API writes', () => {
    const output = execFileSync('node', ['scripts/template-cascade.mjs', 'dry-run', 'v0.1.0-test'], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(output).toContain('DRY RUN — no network writes, no git pushes');
    expect(output.split('\n').filter(line => line.includes(': PR'))).toHaveLength(7);
  });
});
