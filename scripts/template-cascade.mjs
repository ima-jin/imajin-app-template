#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { branchFor, discoverApps, dryRun, summary, templateRepo, validateApps } from './lib/template-cascade.mjs';
import { commentOnRelease, syncApp } from './lib/template-cascade-api.mjs';

const [command = 'dry-run', tag = process.env.TEMPLATE_TAG] = process.argv.slice(2);
branchFor(tag);
if (command === 'discover' || command === 'dry-run') {
  const apps = await discoverApps({ registryUrl: process.env.TEMPLATE_REGISTRY_URL });
  if (command === 'discover') {
    appendFileSync(process.env.GITHUB_OUTPUT, `apps=${JSON.stringify(apps)}\n`);
  } else {
    console.log(`DRY RUN — no network writes, no git pushes\n${dryRun(apps, tag)}`);
  }
} else if (command === 'sync') {
  const [app] = validateApps([JSON.parse(process.env.CASCADE_APP)]);
  let result;
  try {
    if (!process.env.GH_TOKEN) throw new Error('Owner-scoped WARP_FACTORIES_TOKEN is required');
    result = syncApp({
      app, tag, sha: process.env.TEMPLATE_SHA,
      templateUrl: `${process.env.GITHUB_SERVER_URL}/${templateRepo}.git`,
    });
  } catch {
    // Do not log subprocess errors: credential helpers and HTTP clients may
    // include sensitive context. The failed app remains visible in the summary.
    result = { sourceRepo: app.sourceRepo, status: 'failed', detail: 'Check installation access, history and templateRef; rerun this tag after repair.' };
    process.exitCode = 1;
  }
  mkdirSync('cascade-results', { recursive: true });
  writeFileSync(`cascade-results/${app.owner}-${app.sourceRepo.split('/')[1]}.json`, JSON.stringify(result));
  console.log(summary([result], tag));
} else if (command === 'report') {
  const apps = JSON.parse(process.env.CASCADE_APPS);
  const results = readdirSync('cascade-results').filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(`cascade-results/${name}`, 'utf8')));
  for (const app of apps) {
    if (!results.some(result => result.sourceRepo === app.sourceRepo)) {
      results.push({ sourceRepo: app.sourceRepo, status: 'failed (no job result)' });
    }
  }
  const body = summary(results, tag);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
  commentOnRelease({ repo: templateRepo, releaseId: process.env.RELEASE_ID, tag, body });
  if (results.some(result => result.status.startsWith('failed'))) process.exitCode = 1;
} else {
  throw new Error('Use discover, dry-run, sync or report');
}
