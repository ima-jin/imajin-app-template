# Migrations — ownership rule

This app manages its own database with `drizzle-orm` + `drizzle-kit`, entirely separate from
the Imajin kernel's own database.

## The rule (ima-jin/imajin-ai#1991)

> An app owns tables only in its own Postgres schema. Cross-schema access from an app is a
> contract violation — it goes through the kernel API instead.

Concretely, for this app:

- This app owns exactly **one** Postgres schema, named by the `APP_DB_SCHEMA` env var
  (see `.env.example`). `src/db/schema.ts` defines every table inside that schema via
  `pgSchema(process.env.APP_DB_SCHEMA)` — there is no path to creating a table outside it.
- This app **never** connects to, queries, or migrates a kernel-owned schema (`registry`,
  `auth`, `profile`, …) or another app's schema. Every interaction with kernel-owned data goes
  through the kernel's public HTTP API (`IMAJIN_AUTH_URL`), authenticated the same way any
  other caller would be — see `docs/REGISTRATION.md` and `AGENTS.md` §2.
- `DATABASE_URL` in this app's own `.env.local` points at this app's own Postgres database (or
  a database this app has been granted a role scoped to `APP_DB_SCHEMA` in) — never the
  kernel's database.
- `APP_DB_SCHEMA` is set once, at registration time, and never changed afterwards. Renaming it
  would orphan every existing migration's tracking state.

## Workflow

```bash
pnpm db:generate   # diff src/db/schema.ts against migrations/ and write new SQL
pnpm db:migrate     # apply pending migrations in migrations/ to DATABASE_URL
pnpm db:studio      # browse this app's own schema
```

`migrations/` is committed. `drizzle.config.ts` scopes `drizzle-kit` to `APP_DB_SCHEMA` only
(`schemaFilter`), so `pnpm db:generate` can never emit a migration for a table outside this
app's own schema.

## Enforced in CI

`.github/workflows/check-migrations.yml` runs `scripts/check-migrations.mjs` on every PR and push to `main`:

- every object `migrations/*.sql` creates or alters lives in **one** schema — never `public`, never a kernel-owned
  schema (`registry`, `auth`, `profile`), never a second app schema;
- `migrations/` is contiguous (`0000_…`, `0001_…`), non-empty, and matches drizzle's `meta/_journal.json` — a
  hand-added or hand-edited migration fails;
- `src/db` declares tables only through the env-derived app schema (`pgSchema(process.env.APP_DB_SCHEMA)`), and
  `drizzle.config.ts` keeps its `schemaFilter`;
- `drizzle-kit generate` against the committed schema is a no-op — if you changed `src/db/schema.ts`, you must
  commit the migration `pnpm db:generate` produced.

Run the static half locally with `node scripts/check-migrations.mjs`. An app that owns no database (no
`drizzle.config.ts`) is not subject to the check.

## What this app does not do

- It does not squash, rewrite, or otherwise manage the kernel's own migration history — that is
  the kernel repo's concern (imajin-ai#1991's baseline-squash work), not this app's.
- It does not read another app's schema directly, even for apps that happen to share a Postgres
  instance in some deployments. If you need data another app owns, that app's owner exposes it
  through a kernel-consumed API — ask for that API, don't reach for its tables.
