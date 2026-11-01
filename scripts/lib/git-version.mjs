// Ported from ima-jin/imajin-ai/scripts/lib/git-version.mjs.
// Keep tag selection aligned with that repo's build-version.sh: marker tags
// must never override a reachable vX.Y.Z release.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

export const KNOWN_GIT_LOCATIONS = ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git', '/bin/git'];

export function resolveGitBinary() {
  if (process.env.GIT_BIN && isAbsolute(process.env.GIT_BIN)) return process.env.GIT_BIN;
  const found = KNOWN_GIT_LOCATIONS.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error('git binary not found. Set GIT_BIN to its absolute path.');
}

export function gitOutput(gitBin, root, args) {
  return execFileSync(gitBin, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function latestTagVersion(gitBin, root) {
  try {
    const out = gitOutput(gitBin, root, ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
    return out ? out.replace(/^v/, '') : undefined;
  } catch {
    // No matching reachable release (including no git): use package.json.
    return undefined;
  }
}
