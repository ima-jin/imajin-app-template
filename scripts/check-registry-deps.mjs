#!/usr/bin/env node
/**
 * Proves this app consumes every dependency (incl. @ima-jin/*) from the
 * published npm registry — no workspace:/link:/file: specifiers, no
 * monorepo-scope (@imajin/*) packages, no registry redirects in .npmrc.
 * Run by the `registry-install` job in .github/workflows/ci.yml.
 *
 *   node scripts/check-registry-deps.mjs              # static checks (package.json, lockfile, .npmrc)
 *   node scripts/check-registry-deps.mjs --installed  # after install: @ima-jin/* resolve into the pnpm store
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { checkLockfile, checkNpmrc, checkPackageJson, isInstalledFromStore } from './lib/registry-deps-check.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const errors = [...checkPackageJson(pkg)];

if (existsSync('pnpm-lock.yaml')) errors.push(...checkLockfile(readFileSync('pnpm-lock.yaml', 'utf8')));
errors.push(...checkNpmrc(existsSync('.npmrc') ? readFileSync('.npmrc', 'utf8') : null));

const scoped = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => name.startsWith('@ima-jin/'));

// Store-layout check is pnpm-specific (node_modules/.pnpm); npm/yarn forks only get the static checks.
if (process.argv.includes('--installed') && existsSync('pnpm-lock.yaml')) {
  for (const name of scoped) {
    const installed = join('node_modules', name);
    if (!existsSync(installed)) {
      errors.push(`${name}: not installed`);
    } else if (!isInstalledFromStore(realpathSync(installed))) {
      errors.push(`${name}: resolves to ${realpathSync(installed)}, outside pnpm's store — not a registry install`);
    }
  }
}

if (errors.length > 0) {
  console.error('check-registry-deps: FAILED');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`check-registry-deps: ok (${scoped.length} @ima-jin/* package(s) from the npm registry)`);
