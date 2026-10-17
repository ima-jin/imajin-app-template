import { describe, expect, it, vi } from 'vitest';
import { deploymentArgs, githubClient, recordDeployment, verifyLiveBuild } from '../deployment.mjs';

const build = {
  repo: 'owner/app', sha: 'a'.repeat(40), environment: 'dev', url: 'https://app.example.test/prefix',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('deployment CLI contract', () => {
  it('requires dev/prod, an absolute command, and a safe URL', () => {
    expect(deploymentArgs(['--environment', 'dev', '--url', `${build.url}/`, '--', '/usr/bin/true'])).toEqual({
      environment: 'dev', url: build.url, command: ['/usr/bin/true'],
    });
    expect(deploymentArgs(['--environment', 'prod', '--url', 'http://127.0.0.1:3000', '--', '/bin/sh', 'deploy.sh']).environment).toBe('prod');
    for (const args of [
      [], ['--environment', 'staging'], ['--environment', 'dev', '--url', build.url, '--', 'relative'],
    ]) expect(() => deploymentArgs(args)).toThrow('Usage:');
    for (const url of ['http://public.test', 'https://u:p@app.test', 'https://app.test/?query', 'https://app.test/#hash']) {
      expect(() => deploymentArgs(['--environment', 'dev', '--url', url, '--', '/bin/sh'])).toThrow('Deploy URL');
    }
  });
});

describe('GitHub App authentication', () => {
  it('rejects PATs before making a request', () => {
    expect(() => githubClient('github_pat_not-a-real-token')).toThrow('PATs are not accepted');
  });
  it('uses the installation token only in HTTPS API headers and disables redirects', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json({ id: 42 }));
    const github = githubClient('ghs_test-placeholder', fetchImpl);
    expect(await github('/repos/owner/app/deployments', { ref: build.sha })).toEqual({ id: 42 });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/repos/owner/app/deployments', expect.objectContaining({
      method: 'POST', redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'Bearer ghs_test-placeholder' }),
      body: JSON.stringify({ ref: build.sha }),
    }));
    await github('/installation/repositories');
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: 'GET', body: undefined });
  });
  it('does not echo GitHub response bodies on API failure', async () => {
    const github = githubClient('ghs_test-placeholder', vi.fn().mockResolvedValue(json({ secret: 'never-print' }, 403)));
    await expect(github('/installation/repositories')).rejects.toThrow('HTTP 403');
  });
});

describe('live build verification', () => {
  it('polls through a restart and a stale SHA, preserving the base path', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('restarting'))
      .mockResolvedValueOnce(json({ ...build, sha: 'old' })).mockResolvedValueOnce(json(build));
    const wait = vi.fn();
    await verifyLiveBuild(build, { fetchImpl, wait, attempts: 3 });
    expect(wait).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${build.url}/api/build`);
  });
  it('rejects a wrong repository or unhealthy endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ ...build, repo: 'other/app' }));
    await expect(verifyLiveBuild(build, { fetchImpl, wait: vi.fn(), attempts: 2 })).rejects.toThrow('did not match');
  });
});

describe('GitHub Deployment lifecycle', () => {
  function fixture() {
    const github = vi.fn().mockImplementation(async (path: string) => (
      path.endsWith('/deployments') ? { id: 42 } : {}
    ));
    return { github, deploy: vi.fn(), verify: vi.fn() };
  }

  it.each(['dev', 'prod'])('records a verified %s deployment with success', async (environment) => {
    const dependencies = fixture();
    expect(await recordDeployment({ ...build, environment }, dependencies)).toBe(42);
    expect(dependencies.github.mock.calls[0][0]).toBe('/installation/repositories?per_page=1');
    expect(dependencies.github.mock.calls[1]).toEqual(['/repos/owner/app/deployments', {
      ref: build.sha, environment, auto_merge: false, required_contexts: [],
      production_environment: environment === 'prod', payload: { environment_url: build.url },
    }]);
    expect(dependencies.github.mock.calls[2][1]).toMatchObject({ state: 'in_progress', environment_url: build.url });
    expect(dependencies.github.mock.calls[3][1]).toMatchObject({ state: 'success', auto_inactive: true });
    expect(dependencies.deploy).toHaveBeenCalledOnce();
    expect(dependencies.verify).toHaveBeenCalledWith({ ...build, environment });
  });

  it.each(['deploy', 'verify'])('records failure when %s fails without leaking its error', async (step) => {
    const dependencies = fixture();
    dependencies[step as 'deploy' | 'verify'].mockRejectedValue(new Error('secret-child-output'));
    await expect(recordDeployment(build, dependencies)).rejects.toThrow('Deployment 42 failed');
    expect(dependencies.github.mock.calls.at(-1)?.[1]).toMatchObject({ state: 'failure' });
  });

  it('does not run commands if installation validation or deployment creation fails', async () => {
    const dependencies = fixture();
    dependencies.github.mockRejectedValueOnce(new Error('403'));
    await expect(recordDeployment(build, dependencies)).rejects.toThrow('403');
    expect(dependencies.deploy).not.toHaveBeenCalled();
    dependencies.github.mockReset().mockResolvedValue({});
    await expect(recordDeployment(build, dependencies)).rejects.toThrow('did not create');
  });

  it('requires a valid source repository and full SHA', async () => {
    await expect(recordDeployment({ ...build, sha: 'local' }, fixture())).rejects.toThrow('full commit SHA');
    await expect(recordDeployment({ ...build, repo: '' }, fixture())).rejects.toThrow('owner/name');
  });
});
