import { gitOutput, latestTagVersion, resolveGitBinary } from './git-version.mjs';

/** Accept GitHub owner/name, not arbitrary URLs or credential-bearing remotes. */
export function sourceRepository(value = '') {
  const repo = value.trim().replace(/\.git$/, '');
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : '';
}

export function repositoryFromRemote(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote);
  return sourceRepository(match?.[1]);
}

/**
 * Build-time only. Values are inlined by Next into both server and UI bundles.
 * @param {string} root
 * @param {string} packageVersion
 * @param {Record<string, string | undefined>} env
 * @param {Date} now
 */
export function computeBuildInfo(root, packageVersion, env = process.env, now = new Date()) {
  let tag;
  let sha = 'local';
  let repo = '';
  try {
    const git = resolveGitBinary();
    tag = latestTagVersion(git, root);
    if (tag) sha = gitOutput(git, root, ['rev-parse', 'HEAD']);
    repo = repositoryFromRemote(gitOutput(git, root, ['remote', 'get-url', 'origin']));
  } catch {
    // Tarball / missing git / missing origin: explicit public inputs still work.
  }
  return {
    version: env.NEXT_PUBLIC_VERSION || tag || packageVersion || 'dev',
    sha: env.NEXT_PUBLIC_BUILD_HASH || sha,
    repo: sourceRepository(env.NEXT_PUBLIC_SOURCE_REPO) || repo,
    builtAt: env.NEXT_PUBLIC_BUILD_TIME || now.toISOString(),
  };
}
