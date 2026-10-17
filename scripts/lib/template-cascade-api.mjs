import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { branchFor, conflictLabel, joinMarker, pullBody, templateRepo } from './template-cascade.mjs';
import { gitRunner, isAncestor, mergeTemplate } from './template-cascade-git.mjs';

export function githubApi(path, method = 'GET', payload) {
  const args = ['api', path, '--method', method];
  if (payload) args.push('--input', '-');
  const text = execFileSync('gh', args, {
    input: payload ? JSON.stringify(payload) : undefined,
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  return text.trim() ? JSON.parse(text) : null;
}

export function githubList(path) {
  const text = execFileSync('gh', ['api', path, '--paginate', '--slurp'], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(text).flat();
}

export function ensureJoinIssue(repo, api = githubApi, list = githubList) {
  const existing = list(`repos/${repo}/issues?state=all&per_page=100`)
    .find(issue => !issue.pull_request && issue.body?.includes(joinMarker));
  if (existing) return { sourceRepo: repo, status: 'not joined (existing issue)', url: existing.html_url };
  const issue = api(`repos/${repo}/issues`, 'POST', {
    title: "Can't receive template updates — run the one-time join",
    body: `${joinMarker}\nThis app has not joined template history. Follow the one-time history-only join in the template README and scripts/sync-from-template.sh. Use the generating template SHA, NOT today's template/main; open a join PR, never push main directly. After it merges, update registry joined=true and templateRef.\n\nhttps://github.com/${templateRepo}#pulling-template-changes-later`,
  });
  return { sourceRepo: repo, status: 'not joined', url: issue.html_url };
}

export function labelConflict(repo, number, api = githubApi) {
  try {
    api(`repos/${repo}/labels`, 'POST', {
      name: conflictLabel, color: 'b60205', description: 'Template merge conflict: operator enqueue a Warp resolution run',
    });
  } catch (error) {
    // Only tolerate the label already existing; permission/network errors
    // must not silently drop the operator-loop signal.
    const label = api(`repos/${repo}/labels/${conflictLabel}`);
    if (label.name !== conflictLabel) throw error;
  }
  api(`repos/${repo}/issues/${number}/labels`, 'POST', { labels: [conflictLabel] });
}

export function commitWithApp(repo, branch, api = githubApi) {
  return (git, message, sha) => {
    // The Git-data API requires both parents to exist in the target repo.
    // Seed new template objects on ONLY the sync branch, then fast-forward it
    // to the two-parent merge. A retry recovers this seed if PR creation failed.
    if (!git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)) {
      git('push', 'origin', `${sha}:refs/heads/${branch}`);
    }
    const paths = git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean);
    const entries = new Map(git('ls-files', '--stage', '-z').split('\0').filter(Boolean).map(entry => {
      const tab = entry.indexOf('\t');
      const [mode, object] = entry.slice(0, tab).split(' ');
      return [entry.slice(tab + 1), { mode, object }];
    }));
    const tree = paths.map(path => {
      const entry = entries.get(path);
      if (!entry) return { path, mode: '100644', type: 'blob', sha: null };
      if (entry.mode === '160000') throw new Error('Submodules require operator review');
      // Read binary-safe blob content without exposing it to a shell.
      const content = execFileSync('git', ['cat-file', 'blob', entry.object], {
        cwd: git('rev-parse', '--show-toplevel'), stdio: ['pipe', 'pipe', 'pipe'],
      }).toString('base64');
      const blob = api(`repos/${repo}/git/blobs`, 'POST', { content, encoding: 'base64' });
      return { path, mode: entry.mode, type: 'blob', sha: blob.sha };
    });
    const createdTree = api(`repos/${repo}/git/trees`, 'POST', { base_tree: git('rev-parse', 'HEAD^{tree}'), tree });
    // Omit author/committer: GitHub attributes the commit to the authenticated
    // warp-factories App, without any fabricated or overridden Git identity.
    const created = api(`repos/${repo}/git/commits`, 'POST', {
      message, tree: createdTree.sha, parents: [git('rev-parse', 'HEAD'), sha],
    });
    git('fetch', '--quiet', 'origin', created.sha);
    git('reset', '--hard', created.sha);
  };
}
export function syncApp({ app, tag, sha, templateUrl, api = githubApi, list = githubList, prepare = prepareRepo }) {
  const branch = branchFor(tag);
  const repo = app.sourceRepo;
  if (!app.joined) return ensureJoinIssue(repo, api, list);
  const prs = list(`repos/${repo}/pulls?state=all&head=${app.owner}:${branch}&base=main&per_page=100`);
  const existing = prs.find(pr => pr.head.ref === branch);
  if (existing?.state === 'closed') {
    return { sourceRepo: repo, status: 'skipped (PR already closed or merged)', url: existing.html_url };
  }
  const cwd = prepare({ repo, branch, existing, templateUrl, sha });
  const git = gitRunner(cwd);
  try {
    git('merge-base', 'origin/main', sha);
  } catch (error) {
    if (error.status === 1) return ensureJoinIssue(repo, api, list);
    throw error;
  }
  const merge = mergeTemplate({ cwd, sha, tag, templateRef: app.templateRef, commit: commitWithApp(repo, branch, api) });
  if (!merge.changed && !existing && isAncestor(git, sha, 'origin/main')) {
    return { sourceRepo: repo, status: 'skipped (already synced)' };
  }
  // A retry does not rebuild or force-push an existing resolution branch.
  if (merge.changed) git('push', 'origin', `HEAD:refs/heads/${branch}`);
  const body = pullBody({ tag, sha, ...merge });
  let pr;
  if (existing) {
    // Preserve an operator's draft/conflict state on no-op retries.
    pr = api(`repos/${repo}/pulls/${existing.number}`, 'PATCH',
      merge.changed ? { body } : { title: existing.title });
  } else {
    pr = api(`repos/${repo}/pulls`, 'POST', {
      title: `chore: sync template ${tag}`, head: branch, base: 'main', body, draft: merge.conflicts.length > 0,
    });
  }
  if (merge.conflicts.length > 0) {
    if (!pr.draft) {
      execFileSync('gh', ['pr', 'ready', String(pr.number), '--undo', '--repo', repo], { stdio: 'pipe' });
    }
    labelConflict(repo, pr.number, api);
  }
  const conflict = merge.conflicts.length > 0 || pr.draft;
  return { sourceRepo: repo, status: conflict ? 'conflict (draft; operator hook)' : 'PR', url: pr.html_url };
}

/** @param {{repo: string, branch: string, existing?: object, templateUrl: string, sha: string}} options */
export function prepareRepo({ repo, branch, existing = undefined, templateUrl, sha }) {
  const cwd = mkdtempSync(`${tmpdir()}/template-cascade-`);
  const git = gitRunner(cwd);
  git('init', '--quiet');
  // Credential is supplied only through the environment, never a URL, argument,
  // persisted git config or log. The runner never executes app-authored code.
  git('config', 'credential.helper',
    '!f() { printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; }; f');
  git('remote', 'add', 'origin', `https://github.com/${repo}.git`);
  git('fetch', '--quiet', 'origin', 'main');
  git('update-ref', 'refs/remotes/origin/main', 'FETCH_HEAD');
  git('remote', 'add', 'template', templateUrl);
  git('fetch', '--quiet', 'template', 'main', '--tags');
  git('cat-file', '-e', `${sha}^{commit}`);
  const remoteBranch = git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
  if (existing || (remoteBranch && remoteBranch.split(/\s+/)[0] !== sha)) {
    git('fetch', '--quiet', 'origin', branch);
    git('checkout', '-b', branch, 'FETCH_HEAD');
  } else {
    git('checkout', '-b', branch, 'origin/main');
  }
  return cwd;
}

export function commentOnRelease({ repo, releaseId, tag, body, api = githubApi, list = githubList }) {
  const marker = `<!-- template-cascade:release:${releaseId} -->`;
  const release = api(`repos/${repo}/releases/${releaseId}`);
  // Releases have no REST comment endpoint. Comment on the release tag's
  // commit, with the release link, and link that comment from the release notes.
  const commit = api(`repos/${repo}/commits/${encodeURIComponent(tag)}`);
  const comments = list(`repos/${repo}/commits/${commit.sha}/comments?per_page=100`);
  const existing = comments.find(comment => comment.body.includes(marker) && comment.user.login === 'warp-factories[bot]');
  const commentBody = `${marker}\nRelease: ${release.html_url}\n\n${body}`;
  const comment = existing
    ? api(`repos/${repo}/comments/${existing.id}`, 'PATCH', { body: commentBody })
    : api(`repos/${repo}/commits/${commit.sha}/comments`, 'POST', { body: commentBody });
  const start = '<!-- template-cascade:summary start -->';
  const end = '<!-- template-cascade:summary end -->';
  const notes = release.body || '';
  const block = `${start}\n${body}\n[Cascade release comment](${comment.html_url})\n${end}`;
  const from = notes.indexOf(start);
  const to = notes.indexOf(end, from);
  const updated = from >= 0 && to >= from
    ? notes.slice(0, from) + block + notes.slice(to + end.length)
    : `${notes}\n\n${block}`;
  api(`repos/${repo}/releases/${releaseId}`, 'PATCH', { body: updated });
}
