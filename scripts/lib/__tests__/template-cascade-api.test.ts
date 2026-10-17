import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  exec: vi.fn(), git: vi.fn(), merge: vi.fn(), ancestor: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFileSync: mocks.exec }));
vi.mock('../template-cascade-git.mjs', () => ({
  gitRunner: () => mocks.git, mergeTemplate: mocks.merge, isAncestor: mocks.ancestor,
}));
import {
  commentOnRelease, commitWithApp, ensureJoinIssue, githubApi, githubList,
  labelConflict, prepareRepo, syncApp,
} from '../template-cascade-api.mjs';
import { branchFor, joinMarker } from '../template-cascade.mjs';

const app = { sourceRepo: 'gbscontracting/website', owner: 'gbscontracting', joined: true, templateRef: null };
const branch = branchFor('v1');
const pr = { number: 12, html_url: 'https://example.test/pr/12', state: 'open', draft: false,
  head: { ref: branch }, title: 'sync' };
const options = { app, tag: 'v1', sha: 'a'.repeat(40), templateUrl: 'https://example.test/template.git' };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.git.mockReturnValue('');
  mocks.merge.mockReturnValue({ changed: true, conflicts: [], changelog: '- update' });
  mocks.exec.mockReturnValue('');
});

describe('GitHub transport', () => {
  it('uses JSON stdin and paginates every list', () => {
    mocks.exec.mockReturnValueOnce('{"number":1}').mockReturnValueOnce('').mockReturnValueOnce('[[1],[2]]');
    expect(githubApi('repos/a/b/issues', 'POST', { title: 'literal $(input)' })).toEqual({ number: 1 });
    expect(mocks.exec.mock.calls[0][2].input).toBe('{"title":"literal $(input)"}');
    expect(githubApi('repos/a/b')).toBeNull();
    expect(githubList('repos/a/b/issues')).toEqual([1, 2]);
    expect(mocks.exec.mock.calls[2][1]).toContain('--paginate');
  });
  it('creates exactly one issue across tags, including a closed prior issue', () => {
    const api = vi.fn().mockReturnValue({ html_url: 'issue' });
    expect(ensureJoinIssue(app.sourceRepo, api, () => [])).toMatchObject({ status: 'not joined' });
    expect(api.mock.calls[0][2].body).toContain(joinMarker);
    api.mockClear();
    expect(ensureJoinIssue(app.sourceRepo, api, () => [
      { body: joinMarker, pull_request: {}, html_url: 'not-an-issue' },
      { body: joinMarker, state: 'closed', html_url: 'issue' },
    ])).toMatchObject({ status: 'not joined (existing issue)', url: 'issue' });
    expect(api).not.toHaveBeenCalled();
  });
  it('signals the conflict hook even when its label already exists', () => {
    const api = vi.fn().mockImplementation((path, method) => {
      if (path === 'repos/gbscontracting/website/labels' && method === 'POST') throw new Error('exists');
      return { name: 'template-sync-conflict' };
    });
    labelConflict(app.sourceRepo, 12, api);
    expect(api).toHaveBeenLastCalledWith('repos/gbscontracting/website/issues/12/labels', 'POST',
      { labels: ['template-sync-conflict'] });
    api.mockImplementation(() => { throw new Error('403'); });
    expect(() => labelConflict(app.sourceRepo, 12, api)).toThrow('403');
  });
});

describe('per-app orchestration', () => {
  it('creates a PR in the target org and never pushes main or force-pushes', () => {
    const api = vi.fn().mockReturnValue(pr);
    expect(syncApp({ ...options, api, list: () => [], prepare: () => '/tmp/app' })).toMatchObject({ status: 'PR' });
    expect(api).toHaveBeenCalledWith('repos/gbscontracting/website/pulls', 'POST',
      expect.objectContaining({ head: branch, base: 'main', draft: false }));
    expect(mocks.git).toHaveBeenCalledWith('push', 'origin', `HEAD:refs/heads/${branch}`);
    expect(mocks.git.mock.calls.flat()).not.toContain('--force');
    expect(mocks.git.mock.calls.filter(args => args[0] === 'push').flat()).not.toContain('main');
  });
  it('opens a draft with conflict paths and labels it for the operator loop', () => {
    mocks.merge.mockReturnValue({ changed: true, conflicts: ['shell.txt'], changelog: '- shell' });
    const api = vi.fn().mockReturnValue({ ...pr, draft: true });
    expect(syncApp({ ...options, api, list: () => [], prepare: () => '/tmp/app' }).status).toContain('conflict');
    expect(api.mock.calls[0][2]).toMatchObject({ draft: true, body: expect.stringContaining('`shell.txt`') });
    expect(api).toHaveBeenLastCalledWith('repos/gbscontracting/website/issues/12/labels', 'POST',
      { labels: ['template-sync-conflict'] });
  });
  it('recovers PR creation after a prior successful push', () => {
    mocks.merge.mockReturnValue({ changed: false, conflicts: ['shell.txt'], changelog: '- shell' });
    mocks.ancestor.mockReturnValue(false);
    const api = vi.fn().mockReturnValue({ ...pr, draft: true });
    syncApp({ ...options, api, list: () => [], prepare: () => '/tmp/app' });
    expect(api.mock.calls[0][2].draft).toBe(true);
    expect(mocks.git.mock.calls.some(args => args[0] === 'push')).toBe(false);
  });
  it('updates an existing PR without overwriting operator work on a no-op retry', () => {
    mocks.merge.mockReturnValue({ changed: false, conflicts: [], changelog: '' });
    const api = vi.fn().mockReturnValue({ ...pr, draft: true });
    syncApp({ ...options, api, list: () => [pr], prepare: () => '/tmp/app' });
    expect(api).toHaveBeenCalledOnce();
    expect(api).toHaveBeenCalledWith('repos/gbscontracting/website/pulls/12', 'PATCH', { title: 'sync' });
    expect(mocks.git.mock.calls.some(args => args[0] === 'push')).toBe(false);
  });
  it('converts an existing PR to draft if a new merge conflicts', () => {
    mocks.merge.mockReturnValue({ changed: true, conflicts: ['x'], changelog: '' });
    const api = vi.fn().mockReturnValue(pr);
    syncApp({ ...options, api, list: () => [pr], prepare: () => '/tmp/app' });
    expect(mocks.exec).toHaveBeenCalledWith('/usr/bin/gh',
      ['pr', 'ready', '12', '--undo', '--repo', app.sourceRepo], { stdio: 'pipe' });
  });
  it('skips closed/merged PRs and truly already-synced main', () => {
    const prepare = vi.fn();
    const api = vi.fn();
    expect(syncApp({ ...options, api, prepare, list: () => [{ ...pr, state: 'closed' }] }).status).toContain('skipped');
    expect(prepare).not.toHaveBeenCalled();
    mocks.merge.mockReturnValue({ changed: false, conflicts: [], changelog: '' });
    mocks.ancestor.mockReturnValue(true);
    expect(syncApp({ ...options, api, prepare: () => '/tmp/app', list: () => [] }).status).toContain('already synced');
    expect(api).not.toHaveBeenCalled();
  });
  it('routes declared or detected unrelated histories to join issues, not a dangerous merge', () => {
    const api = vi.fn().mockReturnValue({ html_url: 'issue' });
    expect(syncApp({ ...options, app: { ...app, joined: false }, api, list: () => [] }).status).toBe('not joined');
    mocks.git.mockImplementation(() => { throw Object.assign(new Error('unrelated'), { status: 1 }); });
    expect(syncApp({ ...options, api, list: () => [], prepare: () => '/tmp/app' }).status).toBe('not joined');
    mocks.git.mockImplementation(() => { throw Object.assign(new Error('bad'), { status: 128 }); });
    expect(() => syncApp({ ...options, api, list: () => [], prepare: () => '/tmp/app' })).toThrow('bad');
  });
});

describe('repository preparation and App commits', () => {
  it('fetches full history and recovers either an existing branch or an interrupted seed', () => {
    prepareRepo({ ...options, repo: app.sourceRepo, branch });
    expect(mocks.git).toHaveBeenCalledWith('checkout', '-b', branch, 'origin/main');
    mocks.git.mockImplementation((...args) => args[0] === 'ls-remote' ? 'resolved-sha\trefs/heads/sync' : '');
    prepareRepo({ ...options, repo: app.sourceRepo, branch, existing: pr });
    expect(mocks.git).toHaveBeenCalledWith('checkout', '-b', branch, 'FETCH_HEAD');
    mocks.git.mockImplementation((...args) => args[0] === 'ls-remote' ? `${options.sha}\trefs/heads/sync` : '');
    prepareRepo({ ...options, repo: app.sourceRepo, branch });
    expect(mocks.git).toHaveBeenLastCalledWith('checkout', '-b', branch, 'origin/main');
  });
  it('uploads binary-safe blobs, deletions and two-parent commits without author overrides', () => {
    mocks.exec.mockReturnValue(Buffer.from([0, 255]));
    mocks.git.mockImplementation((...args) => {
      if (args[0] === 'diff') return 'added\0deleted\0';
      if (args[0] === 'ls-files') return '100644 blob-sha 0\tadded\0';
      if (args[0] === 'rev-parse') return 'base-sha';
      return '';
    });
    const api = vi.fn().mockReturnValue({ sha: 'created-sha' });
    commitWithApp(app.sourceRepo, branch, api)(mocks.git, 'merge', options.sha);
    expect(api.mock.calls[0][2]).toEqual({ content: 'AP8=', encoding: 'base64' });
    expect(api.mock.calls[1][2].tree).toContainEqual({ path: 'deleted', mode: '100644', type: 'blob', sha: null });
    expect(api.mock.calls[2][2]).toEqual({
      message: 'merge', tree: 'created-sha', parents: ['base-sha', options.sha],
    });
    expect(mocks.git).toHaveBeenCalledWith('push', 'origin', `${options.sha}:refs/heads/${branch}`);
    expect(mocks.git).toHaveBeenLastCalledWith('reset', '--hard', 'created-sha');
  });
  it('does not reset remote branches and rejects submodule imports', () => {
    mocks.git.mockImplementation((...args) => {
      if (args[0] === 'ls-remote') return 'existing';
      if (args[0] === 'diff') return 'module\0';
      if (args[0] === 'ls-files') return '160000 sha 0\tmodule\0';
      return '';
    });
    expect(() => commitWithApp(app.sourceRepo, branch, vi.fn())(mocks.git, 'merge', options.sha)).toThrow('Submodules');
    expect(mocks.git.mock.calls.some(args => args[0] === 'push')).toBe(false);
  });
});

describe('release reporting', () => {
  it.each([false, true])('preserves notes and creates/updates one release-linked comment; retry=%s', retry => {
    const start = '<!-- template-cascade:summary start -->';
    const end = '<!-- template-cascade:summary end -->';
    const api = vi.fn().mockImplementation((path, method) => {
      if (path.endsWith('/releases/3') && method === undefined) {
        return { body: retry ? `Notes\n${start}\nold\n${end}\nSuffix` : 'Notes', html_url: 'release' };
      }
      return { sha: 'tag-sha', html_url: 'comment' };
    });
    const list = () => retry ? [{
      id: 5, body: '<!-- template-cascade:release:3 -->', user: { login: 'warp-factories[bot]' },
    }] : [];
    commentOnRelease({ repo: 'a/b', releaseId: 3, tag: 'v1', body: 'results', api, list });
    expect(api).toHaveBeenCalledWith(retry ? 'repos/a/b/comments/5' : 'repos/a/b/commits/tag-sha/comments',
      retry ? 'PATCH' : 'POST', expect.objectContaining({ body: expect.stringContaining('Release: release') }));
    const notes = api.mock.calls.at(-1)?.[2].body;
    expect(notes).toContain('Notes');
    expect(notes).toContain('[Cascade release comment](comment)');
    expect(notes.split(start)).toHaveLength(2);
    if (retry) expect(notes).toContain('Suffix');
  });
});
