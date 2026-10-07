import { describe, expect, it } from 'vitest';
import {
  checkDrizzleConfig,
  checkMigrations,
  checkSchemaSource,
  schemasReferenced,
} from '../migrations-check.mjs';

const CREATE = 'CREATE SCHEMA "my_app";\n--> statement-breakpoint\nCREATE TABLE "my_app"."things" ("id" uuid);\n';
const file = (name: string, content = CREATE) => ({ name, content });
const journal = (...tags: string[]) => ({ entries: tags.map((tag) => ({ tag })) });

describe('schemasReferenced', () => {
  it('finds qualified objects and schema DDL', () => {
    expect([...schemasReferenced(CREATE)]).toEqual(['my_app']);
    expect([...schemasReferenced('DROP SCHEMA IF EXISTS "other";')]).toEqual(['other']);
  });
});

describe('checkMigrations', () => {
  it('accepts a consistent single-schema folder and reports the owned schema', () => {
    const result = checkMigrations(
      [file('0000_init.sql'), file('0001_more.sql', 'ALTER TABLE "my_app"."things" ADD COLUMN "x" text;')],
      journal('0000_init', '0001_more'),
    );
    expect(result).toEqual({ errors: [], schema: 'my_app' });
  });

  it('accepts an empty folder with an empty journal', () => {
    expect(checkMigrations([], journal())).toEqual({ errors: [], schema: null });
  });

  it('rejects bad names, duplicate numbers and gaps', () => {
    const { errors } = checkMigrations(
      [file('init.sql'), file('0000_a.sql'), file('0000_b.sql'), file('0003_c.sql')],
      journal('0000_a', '0000_b', '0003_c'),
    );
    expect(errors.some((e: string) => e.includes('init.sql: invalid name'))).toBe(true);
    expect(errors.some((e: string) => e.includes('0000_b.sql: duplicate migration number 0000'))).toBe(true);
    expect(errors.some((e: string) => e.includes('0003_c.sql: gap in numbering (expected 0001)'))).toBe(true);
  });

  it('rejects an empty migration', () => {
    const { errors } = checkMigrations([file('0000_a.sql', '  \n')], journal('0000_a'));
    expect(errors).toContain('0000_a.sql: empty migration');
  });

  it('requires the journal to exist and to match the files', () => {
    expect(checkMigrations([file('0000_a.sql')], null).errors[0]).toContain('_journal.json is missing');
    const mismatch = checkMigrations([file('0000_a.sql')], journal('0000_other'));
    expect(mismatch.errors[0]).toContain('does not match the .sql files');
  });

  it('rejects public and kernel-owned schemas', () => {
    for (const schema of ['public', 'registry', 'auth', 'profile']) {
      const sql = `CREATE TABLE "${schema}"."t" ("id" uuid);`;
      const { errors } = checkMigrations([file('0000_a.sql', sql)], journal('0000_a'));
      expect(errors.some((e: string) => e.includes(`schema "${schema}", which this app does not own`))).toBe(true);
    }
  });

  it('rejects touching a second schema', () => {
    const sql = `${CREATE}ALTER TABLE "my_app"."things" ADD CONSTRAINT fk FOREIGN KEY ("id") REFERENCES "other_app"."t"("id");`;
    const { errors, schema } = checkMigrations([file('0000_a.sql', sql)], journal('0000_a'));
    expect(errors.some((e: string) => e.includes('touch 2 schemas'))).toBe(true);
    expect(schema).toBeNull();
  });

  it('rejects objects created without a schema qualifier', () => {
    const { errors } = checkMigrations([file('0000_a.sql', 'CREATE TABLE "loose" ("id" uuid);')], journal('0000_a'));
    expect(errors.some((e: string) => e.includes('without a schema qualifier'))).toBe(true);
  });
});

describe('checkSchemaSource', () => {
  it('accepts tables declared through an env-derived pgSchema', () => {
    const src = 'const s = pgSchema(appSchemaName);\nexport const t = s.table("t", {});';
    expect(checkSchemaSource('src/db/schema.ts', src)).toEqual([]);
  });

  it('rejects public-schema builders and literal schema names', () => {
    expect(checkSchemaSource('a.ts', 'export const t = pgTable("t", {});')[0]).toContain('outside the app schema');
    expect(checkSchemaSource('a.ts', "const s = pgSchema('registry');")[0]).toContain('literal name');
  });
});

describe('checkDrizzleConfig', () => {
  it('requires schemaFilter', () => {
    expect(checkDrizzleConfig('export default { schemaFilter: [x] }')).toEqual([]);
    expect(checkDrizzleConfig('export default {}')[0]).toContain('schemaFilter');
  });
});
