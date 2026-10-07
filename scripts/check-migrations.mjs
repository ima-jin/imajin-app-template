#!/usr/bin/env node
/**
 * Migrations check for an app that owns its own schema + migrations/ folder
 * (docs/MIGRATIONS.md). Run by .github/workflows/check-migrations.yml.
 *
 *   node scripts/check-migrations.mjs                # run every check, exit 1 on any error
 *   node scripts/check-migrations.mjs --print-schema # print the one schema the migrations own
 *
 * Checks (logic in scripts/lib/migrations-check.mjs):
 *   - migrations/*.sql are NNNN_name.sql, contiguous, non-empty, match drizzle's journal
 *   - every object the migrations touch lives in ONE schema, not public/kernel-owned
 *   - src/db declares tables only through the app schema (no pgTable/literal pgSchema)
 *   - drizzle.config.ts still scopes drizzle-kit with schemaFilter
 *   - no stray .sql migration files outside migrations/
 * The schema.ts <-> migrations drift check (schema changed, no migration) is done
 * by the workflow itself by running `drizzle-kit generate` and failing on a diff.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDrizzleConfig, checkMigrations, checkSchemaSource } from './lib/migrations-check.mjs';

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'coverage', '.pnpm-store', 'migrations']);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), visit);
    } else {
      visit(join(dir, entry.name));
    }
  }
}

const printSchema = process.argv.includes('--print-schema');
const migrationsDir = 'migrations';

if (!existsSync('drizzle.config.ts')) {
  if (!printSchema) console.log('No drizzle.config.ts — this app owns no database; nothing to check.');
  process.exit(0);
}

const errors = [];
const files = existsSync(migrationsDir)
  ? readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => ({ name, content: readFileSync(join(migrationsDir, name), 'utf8') }))
  : [];
if (!existsSync(migrationsDir)) errors.push('drizzle.config.ts exists but there is no migrations/ folder');

const result = checkMigrations(files, readJson(join(migrationsDir, 'meta', '_journal.json')));
errors.push(...result.errors, ...checkDrizzleConfig(readFileSync('drizzle.config.ts', 'utf8')));

if (existsSync(join('src', 'db'))) {
  walk(join('src', 'db'), (path) => {
    if (/\.(ts|tsx|mjs|js)$/.test(path) && !path.includes('__tests__')) {
      errors.push(...checkSchemaSource(path, readFileSync(path, 'utf8')));
    }
  });
}

walk('.', (path) => {
  if (path.endsWith('.sql')) errors.push(`${path}: migration file outside migrations/ — drizzle-kit only reads migrations/`);
});

if (printSchema) {
  if (result.schema !== null) console.log(result.schema);
  process.exit(0);
}

if (errors.length > 0) {
  console.error('check-migrations: FAILED');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`check-migrations: ok (${files.length} migration(s), schema "${result.schema ?? 'none yet'}")`);
