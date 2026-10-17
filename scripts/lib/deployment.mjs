import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { sourceRepository } from './build-info.mjs';

export function deploymentArgs(args) {
  const separator = args.indexOf('--');
  const { values } = parseArgs({
    args: separator < 0 ? args : args.slice(0, separator),
    options: { environment: { type: 'string' }, url: { type: 'string' } },
  });
  const command = separator < 0 ? [] : args.slice(separator + 1);
  if (!['dev', 'prod'].includes(values.environment) || !values.url || !isAbsolute(command[0] || '')) {
    throw new Error('Usage: deploy.mjs --environment dev|prod --url <app URL> -- /absolute/deploy-command [args]');
  }
  const url = new URL(values.url);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('Deploy URL must be HTTPS (or loopback HTTP), without credentials, query or fragment.');
  }
  return { environment: values.environment, url: url.href.replace(/\/$/, ''), command };
}

/** Installation token stays in this closure; it is never passed to a child process. */
export function githubClient(token, fetchImpl = fetch) {
  if (!token.startsWith('ghs_')) throw new Error('A GitHub App installation token on stdin is required; PATs are not accepted.');
  return async (path, body) => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub Deployment API failed (HTTP ${response.status}).`);
    return response.json();
  };
}

/** Poll the public record, not just health: a stale build can be healthy. */
export async function verifyLiveBuild({ url, sha, repo }, {
  fetchImpl = fetch,
  wait = () => new Promise((resolve) => setTimeout(resolve, 2000)),
  attempts = 30,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(`${url}/api/build`, {
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const live = await response.json();
        if (live.sha === sha && live.repo === repo) return;
      }
    } catch {
      // A restarting listener may be unavailable until the next poll.
    }
    if (attempt + 1 < attempts) await wait();
  }
  throw new Error('Live /api/build did not match the deployed SHA and repository.');
}

export async function recordDeployment(build, { github, deploy, verify = verifyLiveBuild }) {
  const { repo, sha, environment, url } = build;
  if (!sourceRepository(repo) || !/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error('Deployment requires a GitHub owner/name and full commit SHA.');
  }
  // This endpoint only accepts installation tokens, not a PAT/user token.
  await github('/installation/repositories?per_page=1');
  const path = `/repos/${repo}/deployments`;
  const deployment = await github(path, {
    ref: sha,
    environment,
    auto_merge: false,
    required_contexts: [],
    production_environment: environment === 'prod',
    payload: { environment_url: url },
  });
  if (!Number.isSafeInteger(deployment.id)) throw new Error('GitHub did not create a Deployment.');
  const status = (state) => github(`${path}/${deployment.id}/statuses`, {
    state, environment, environment_url: url, auto_inactive: true,
  });
  try {
    await status('in_progress');
    await deploy();
    await verify(build);
    await status('success');
  } catch {
    await status('failure');
    // Never print arbitrary child/API errors, which could contain credentials.
    throw new Error(`Deployment ${deployment.id} failed; inspect the deploy command and live /api/build.`);
  }
  return deployment.id;
}
