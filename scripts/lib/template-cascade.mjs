import { readFileSync } from 'node:fs';

export const templateRepo = 'ima-jin/imajin-app-template';
export const conflictLabel = 'template-sync-conflict';
export const joinMarker = '<!-- template-cascade:join -->';

export function branchFor(tag) {
  if (!/^v[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag) || tag.includes('..') || tag.endsWith('.lock')) {
    throw new Error('Expected a safe v* release tag');
  }
  return `chore/sync-from-template-${tag}`;
}

export function validateApps(payload) {
  const apps = Array.isArray(payload) ? payload : payload.apps;
  if (!Array.isArray(apps) || apps.length === 0 || apps.length > 256) {
    throw new Error('Registry must return 1–256 apps');
  }
  const seen = new Set();
  return apps.map(({ sourceRepo, templateRef = null, joined }) => {
    if (typeof sourceRepo !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(sourceRepo)
      || sourceRepo.toLowerCase() === templateRepo || typeof joined !== 'boolean') {
      throw new Error('Invalid registry sourceRepo or joined flag');
    }
    if (templateRef !== null && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(templateRef)) {
      throw new Error('Invalid templateRef');
    }
    const key = sourceRepo.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate registry repo: ${sourceRepo}`);
    seen.add(key);
    const owner = sourceRepo.split('/')[0].toLowerCase();
    return { sourceRepo, templateRef, joined, owner };
  });
}

export async function discoverApps({ registryUrl = '', fallback = 'derived-apps.json', fetcher = fetch }) {
  if (registryUrl) {
    const url = new URL(registryUrl);
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('Registry URL must be credential-free HTTPS');
    }
    // Never send a GitHub installation token to a service URL. #2905 must
    // expose a non-secret read projection for this workflow (see README).
    const response = await fetcher(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
    return validateApps(await response.json());
  }
  return validateApps(JSON.parse(readFileSync(fallback, 'utf8')));
}

export function keepAppSection(template, app) {
  const heading = /^## 8\. This App.*$/m;
  const appStart = app.search(heading);
  const templateStart = template.search(heading);
  if (appStart < 0 || templateStart < 0) {
    throw new Error('AGENTS.md must have §8 This App on both sides; refusing to overwrite app scope');
  }
  return template.slice(0, templateStart) + app.slice(appStart);
}

export function dryRun(apps, tag) {
  const branch = branchFor(tag);
  return apps.map(app => app.joined
    ? `${app.sourceRepo}: PR ${branch} -> main; merge template/main; keep app §8; conflicts -> draft + ${conflictLabel}`
    : `${app.sourceRepo}: one-time join issue (deduplicate across all releases)`).join('\n');
}

export function pullBody({ tag, sha, changelog = '', conflicts }) {
  const paths = conflicts.map(path => `- \`${path}\``).join('\n');
  const resolution = conflicts.length > 0
    ? `Draft: resolve these conflict-marker files before making ready:\n${paths}\n\nOperator hook: \`${conflictLabel}\` — enqueue a Warp run for this PR; preserve app AGENTS.md §8, resolve markers, run app CI + Sonar, then make ready. No public Warp Actions dispatch API is assumed.`
    : 'Clean merge. The app owner reviews and merges after this app’s CI and Sonar pass.';
  return `<!-- template-cascade:${tag} -->\nSync app-shell changes from ${templateRepo} template/main at ${sha} (release ${tag}).\n\nAGENTS.md §8 is kept from this app. Kernel-facing code stays in versioned @ima-jin/* npm packages.\n\n${resolution}\n\n### Template changelog since last synced ref\n${changelog || 'No new template commits.'}\n`;
}

export function summary(results, tag) {
  const lines = results.map(result => {
    const url = result.url ? ` — ${result.url}` : '';
    const detail = result.detail ? ` — ${result.detail}` : '';
    return `- ${result.sourceRepo}: ${result.status}${url}${detail}`;
  });
  return `## Template cascade ${tag}\n\n${lines.join('\n')}\n`;
}
