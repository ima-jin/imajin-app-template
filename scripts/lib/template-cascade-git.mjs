import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keepAppSection } from './template-cascade.mjs';

export function gitRunner(cwd) {
  return (...args) => execFileSync('/usr/bin/git', args, {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trimEnd();
}

export function isAncestor(git, ancestor, descendant) {
  try {
    git('merge-base', '--is-ancestor', ancestor, descendant);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

/**
 * @param {{cwd: string, sha: string, tag: string, templateRef?: string | null,
 * commit?: (git: (...args: string[]) => string, message: string, sha: string) => void}} options
 */
export function mergeTemplate({ cwd, sha, tag, templateRef = null, commit = undefined }) {
  const git = gitRunner(cwd);
  const base = git('merge-base', 'origin/main', sha);
  // Validate the registry ref against the fetched history; never accept options
  // or silently hide commits with a ref ahead of this release's template tip.
  let since = base;
  if (templateRef) {
    since = git('rev-parse', '--verify', `${templateRef}^{commit}`);
    if (!isAncestor(git, since, sha)) throw new Error('templateRef is not an ancestor of template/main');
  }
  const changelog = git('--no-pager', 'log', '--format=- %h %s', `${since}..${sha}`);
  if (isAncestor(git, sha, 'HEAD')) {
    const record = git('log', '-1', '--format=%B').split('\n').find(line => line.startsWith('Template-Conflicts: '));
    const conflicts = record ? JSON.parse(record.slice('Template-Conflicts: '.length)) : [];
    return { conflicts, changelog, changed: false };
  }
  const show = ref => execFileSync('/usr/bin/git', ['show', ref], {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const appAgents = show('origin/main:AGENTS.md');
  const templateAgents = show(`${sha}:AGENTS.md`);
  const agents = keepAppSection(templateAgents, appAgents);
  let merged;
  try {
    merged = git('merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', 'HEAD', sha);
  } catch (error) {
    if (error.status !== 1) throw error;
    merged = error.stdout.toString();
  }
  const [tree, ...unmerged] = merged.split('\0').filter(Boolean);
  // merge-tree is the same three-way merge without creating a local commit
  // or requiring an identity on a clean hosted runner. It writes text markers
  // into conflicted blobs; binary/delete conflicts are also explicitly listed.
  git('cat-file', '-e', `${tree}^{tree}`);
  git('read-tree', '--reset', '-u', tree);
  writeFileSync(join(cwd, 'AGENTS.md'), agents);
  git('add', '--', 'AGENTS.md');
  const conflicts = unmerged.filter(path => path !== 'AGENTS.md');
  // Materialize unresolved text markers (binary conflicts keep Git's app side)
  // as a draft merge commit so GitHub can open a real, reviewable PR.
  git('add', '-A');
  const message = `chore: sync template ${tag}${conflicts.length ? ' (conflicts require resolution)' : ''}\n\nTemplate-Conflicts: ${JSON.stringify(conflicts)}`;
  if (!commit) throw new Error('An App-attributed commit callback is required');
  commit(git, message, sha);
  if (readFileSync(join(cwd, 'AGENTS.md'), 'utf8') !== agents) {
    throw new Error('AGENTS.md preservation failed');
  }
  return { conflicts, changelog, changed: true };
}
