#!/usr/bin/env node
/**
 * Dependency audit gate — ported from ima-jin/imajin-ai's gate, adapted to a
 * single app.
 *
 * A bare `pnpm audit` fails on ANY qualifying advisory, including ones
 * published overnight against code nobody touched; a gate that red-lights
 * unrelated PRs gets suppressed within a month. So this is a ratchet:
 * advisories listed in .github/audit-baseline.json (a debt ledger, not an
 * allowlist) are tolerated, anything NOT in it fails. A fresh fork starts with
 * an empty baseline — the template's own prod dependencies have no high or
 * critical advisories.
 *
 * It reads a report rather than spawning `pnpm` itself (no PATH lookup, a pure
 * function of its input). The caller produces the report:
 *
 *   pnpm audit --prod --audit-level high --json > audit-report.json || true
 *   node scripts/audit-gate.mjs audit-report.json
 *
 * Exit codes: 0 ok, 1 new advisories, 2 broken pipeline (missing/unparseable
 * report — never conflated with a policy failure, or a gate silently passes).
 *
 * Usage:
 *   node scripts/audit-gate.mjs [report.json]            # fail on new advisories
 *   node scripts/audit-gate.mjs [report.json] --report   # never fail; print status
 *   node scripts/audit-gate.mjs [report.json] --prune    # drop resolved baseline entries
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { byString, collectFindings, decodeReport, evaluate, formatIntroduced } from './lib/audit-gate-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, '.github', 'audit-baseline.json');

const args = process.argv.slice(2);
const REPORT_ONLY = args.includes('--report');
const PRUNE = args.includes('--prune');
const reportArg = args.find((a) => !a.startsWith('--')) ?? 'audit-report.json';
const REPORT_PATH = resolve(ROOT, reportArg);

function fatal(message) {
  console.error(`audit-gate: ${message}`);
  process.exit(2);
}

function readReport() {
  let buf;
  try {
    buf = readFileSync(REPORT_PATH);
  } catch {
    console.error('audit-gate: expected `pnpm audit --prod --audit-level high --json > <file>`');
    fatal(`cannot read audit report at ${REPORT_PATH}`);
  }
  const raw = decodeReport(buf);
  if (!raw.trim()) fatal(`audit report at ${REPORT_PATH} is empty`);
  try {
    return JSON.parse(raw);
  } catch {
    console.error(raw.slice(0, 2000));
    return fatal(`could not parse audit report at ${REPORT_PATH}`);
  }
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return { advisories: [] };
  }
}

const found = collectFindings(readReport());
const baseline = loadBaseline();
const { baselineIds, introduced, resolvedIds } = evaluate(found, baseline);

console.log(`audit-gate: ${found.size} high/critical advisories in prod deps`);
console.log(`            ${baselineIds.size} in baseline, ${introduced.length} new, ${resolvedIds.length} resolved`);

if (resolvedIds.length > 0) {
  console.log('\nResolved since the baseline was taken — remove these from .github/audit-baseline.json:');
  for (const id of [...resolvedIds].sort(byString)) console.log(`  - ${id}`);
}

if (PRUNE) {
  const next = { ...baseline, advisories: (baseline.advisories ?? []).filter((a) => found.has(a.id)) };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`\naudit-gate: baseline pruned to ${next.advisories.length} entries`);
  process.exit(0);
}

if (introduced.length === 0) {
  console.log('\naudit-gate: no new high/critical advisories.');
} else {
  console.log('\nNEW high/critical advisories, not in the baseline:\n');
  for (const line of formatIntroduced(introduced)) console.log(line);
  console.log(
    '\nResolve by upgrading, or by adding a pnpm override (package.json `pnpm.overrides`). If the\n' +
      'advisory genuinely cannot be fixed, add it to .github/audit-baseline.json with a reason —\n' +
      'a reviewable decision, unlike suppressing the whole gate.',
  );
  if (!REPORT_ONLY) process.exit(1);
}
