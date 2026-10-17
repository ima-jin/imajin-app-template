#!/usr/bin/env node
// Wrap the host's install/build/migrate/restart/health command; never mint or
// persist credentials here. A trusted broker supplies an installation token on stdin.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { computeBuildInfo } from './lib/build-info.mjs';
import { gitOutput, resolveGitBinary } from './lib/git-version.mjs';
import { deploymentArgs, githubClient, recordDeployment } from './lib/deployment.mjs';

try {
  const options = deploymentArgs(process.argv.slice(2));
  const root = process.cwd();
  const git = resolveGitBinary();
  if (gitOutput(git, root, ['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error('Deploy from a clean checkout of the target ref.');
  }
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const build = computeBuildInfo(root, version);
  const sha = gitOutput(git, root, ['rev-parse', 'HEAD']);
  const github = githubClient(readFileSync(0, 'utf8').trim());
  const [command, ...args] = options.command;
  const id = await recordDeployment({ ...options, repo: build.repo, sha }, {
    github,
    deploy: () => {
      const result = spawnSync(command, args, {
        cwd: root,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...process.env,
          NEXT_PUBLIC_VERSION: build.version,
          NEXT_PUBLIC_BUILD_HASH: sha,
          NEXT_PUBLIC_SOURCE_REPO: build.repo,
          NEXT_PUBLIC_BUILD_TIME: build.builtAt,
        },
      });
      if (result.error || result.status !== 0) throw new Error('Deploy command failed.');
    },
  });
  console.log(JSON.stringify({ event: 'deployment_success', id, environment: options.environment, sha }));
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Deployment failed.' }));
  process.exitCode = 1;
}
