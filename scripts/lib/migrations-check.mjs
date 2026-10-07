// Pure checks behind scripts/check-migrations.mjs — no I/O, unit-tested in
// scripts/lib/__tests__/migrations-check.test.ts.
//
// The rule being enforced is docs/MIGRATIONS.md: this app owns exactly ONE
// Postgres schema (APP_DB_SCHEMA) and its migrations/ folder only ever touches
// that schema. Unlike a monorepo (many owners, one shared folder, a guard that
// maps files to owners), a single app has one owner, so the check is: every
// object the migrations create or alter lives in one and the same schema, that
// schema is not a shared/kernel one, and the folder is internally consistent
// with drizzle-kit's journal.

/** Schemas an app must never own or touch: Postgres built-ins + kernel-owned schemas named in docs/MIGRATIONS.md. */
export const FORBIDDEN_SCHEMAS = ['public', 'pg_catalog', 'information_schema', 'registry', 'auth', 'profile'];

const MIGRATION_NAME = /^(\d{4})_[\w-]+\.sql$/;
// `"schema"."object"` — drizzle-kit always emits fully-qualified, double-quoted names.
const QUALIFIED = /"([^"]+)"\."[^"]+"/g;
const SCHEMA_DDL = /\b(?:CREATE|ALTER|DROP)\s+SCHEMA\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"([^"]+)"/gi;
// CREATE/ALTER/DROP of a schema-scoped object whose name is NOT schema-qualified (lands in `public`).
const UNQUALIFIED = /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|TYPE|SEQUENCE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"[^"]+"(?!\.)/gi;

/** Distinct schema names a migration's SQL refers to (qualified objects + CREATE/ALTER/DROP SCHEMA). */
export function schemasReferenced(sql) {
  const found = new Set();
  for (const match of sql.matchAll(QUALIFIED)) found.add(match[1]);
  for (const match of sql.matchAll(SCHEMA_DDL)) found.add(match[1]);
  return found;
}

/**
 * @param {{ name: string, content: string }[]} files  contents of migrations/*.sql
 * @param {{ entries?: { tag: string }[] } | null} journal  parsed migrations/meta/_journal.json
 * @returns {{ errors: string[], schema: string | null }}
 */
export function checkMigrations(files, journal) {
  const errors = [];
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : 1));

  let previous = -1;
  for (const file of sorted) {
    const match = MIGRATION_NAME.exec(file.name);
    if (match === null) {
      errors.push(`${file.name}: invalid name (expected NNNN_description.sql)`);
      continue;
    }
    const number = Number(match[1]);
    if (number === previous) {
      errors.push(`${file.name}: duplicate migration number ${match[1]}`);
    } else if (number !== previous + 1) {
      errors.push(`${file.name}: gap in numbering (expected ${String(previous + 1).padStart(4, '0')})`);
    }
    previous = number;
    if (file.content.trim() === '') errors.push(`${file.name}: empty migration`);
  }

  const tags = (journal?.entries ?? []).map((entry) => entry.tag);
  const names = sorted.map((file) => file.name.replace(/\.sql$/, ''));
  if (journal === null && sorted.length > 0) {
    errors.push('migrations/meta/_journal.json is missing or unreadable — generate migrations with `pnpm db:generate`');
  } else if (JSON.stringify(tags) !== JSON.stringify(names)) {
    errors.push(
      `migrations/meta/_journal.json does not match the .sql files (journal: [${tags.join(', ')}], files: [${names.join(', ')}]) — never hand-edit or hand-add migrations; use \`pnpm db:generate\``,
    );
  }

  const owned = new Set();
  for (const file of sorted) {
    for (const schema of schemasReferenced(file.content)) owned.add(schema);
    for (const statement of file.content.match(UNQUALIFIED) ?? []) {
      errors.push(`${file.name}: object created without a schema qualifier (would land in "public"): ${statement.trim()}`);
    }
  }

  for (const schema of owned) {
    if (FORBIDDEN_SCHEMAS.includes(schema)) {
      errors.push(`migrations touch schema "${schema}", which this app does not own (see docs/MIGRATIONS.md)`);
    }
  }
  if (owned.size > 1) {
    errors.push(
      `migrations touch ${owned.size} schemas (${[...owned].join(', ')}); an app owns exactly one — its APP_DB_SCHEMA`,
    );
  }

  return { errors, schema: owned.size === 1 ? [...owned][0] : null };
}

// Drizzle table/enum/view builders that do NOT take a schema, i.e. create objects in `public`.
const UNSCOPED_BUILDERS = /\b(?:pgTable|pgEnum|pgView|pgMaterializedView|pgSequence)\s*\(/;
const LITERAL_SCHEMA = /\bpgSchema\s*\(\s*['"`]/;

/** Source-level ownership check on one file under src/db: app tables must be declared via pgSchema(<env-derived name>). */
export function checkSchemaSource(path, source) {
  const errors = [];
  if (UNSCOPED_BUILDERS.test(source)) {
    errors.push(`${path}: declares objects outside the app schema (pgTable/pgEnum/... create in "public") — use appSchema.table(...)`);
  }
  if (LITERAL_SCHEMA.test(source)) {
    errors.push(`${path}: pgSchema() with a literal name — the schema name must come from APP_DB_SCHEMA`);
  }
  return errors;
}

/** drizzle.config.ts must keep scoping drizzle-kit to the app's schema. */
export function checkDrizzleConfig(source) {
  return source.includes('schemaFilter')
    ? []
    : ['drizzle.config.ts: missing `schemaFilter` — drizzle-kit must be scoped to APP_DB_SCHEMA only'];
}
