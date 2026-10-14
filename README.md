# &lt;App Name&gt; — a third-party app on Imajin

> Forked from [`ima-jin/imajin-app-template`](https://github.com/ima-jin/imajin-app-template). **Read
> [`AGENTS.md`](./AGENTS.md) first** — it defines the boundary this app must not cross.

**Platform:** [Imajin](https://imajin.ai) (sovereign-tech kernel) · **Reference app:** `ima-jin/imajin-scorecard`

This repository **is the app** — a real, arms-length third-party application that composes the Imajin platform
**only through its public app surface** (`requireAppAuth` + the documented kernel API). It holds **no `workspace:*`
deps, no monorepo internals, no DB access, no in-process bus** — it talks to Imajin as an external client. Published
`@ima-jin/*` SDK packages (from npmjs.org, no auth needed) are fine to depend on; they're the same versioned
artifact every app — first-party or third-party — consumes.

## Source of truth is the user's

This app holds nothing authoritative. The signed records are **the user's own**, on their per-DID path. The kernel is
the authoritative **index/projection** of those records — not their owner. The user can walk with their records and
everything still verifies. (See `AGENTS.md` §3.)

## How it composes Imajin

| Header | Meaning |
|--------|---------|
| `X-App-DID` | this app's DID (from registration) |
| `X-App-Authorization` | the attestation ID from the user's consent flow |

The kernel verifies both and returns `{ appDid, userDid, scopes }` — that triple is the app's entire authority.

## Getting started

1. **Create your app repo WITH template history** — clone + rename, **not** GitHub's "Use this template" button
   (see [Creating a new app](#creating-a-new-app-with-template-history) below).
2. **Register this app with the kernel** — see [`docs/REGISTRATION.md`](./docs/REGISTRATION.md).
   You'll get back this app's `appDid` and registry `id`.
3. **Set env**: `cp .env.example .env.local`, then fill in `IMAJIN_APP_DID`,
   `NEXT_PUBLIC_IMAJIN_APP_ID`, `APP_DB_SCHEMA`, `DATABASE_URL`, and
   `IMAJIN_KERNEL_URL`, plus `IMAJIN_AUTH_URL` / `NEXT_PUBLIC_IMAJIN_AUTH_URL` (the kernel base URL — shipped
   empty on purpose). This app refuses to start without `IMAJIN_APP_DID`, `IMAJIN_AUTH_URL`,
   `IMAJIN_KERNEL_URL` and `NEXT_PUBLIC_IMAJIN_APP_ID` set, or if a raw
   `IMAJIN_APP_PRIVATE_KEY` is present (see `instrumentation.ts`) — it fetches its own signing key
   at boot via `@ima-jin/auth-client`'s `loadAppSigningKey()` instead. Claim only in the browser:
   *approve on `/jin` → open `<this app>/claim` → paste the code →
   done* — see [`docs/REGISTRATION.md`](./docs/REGISTRATION.md).
   The kernel issues and seals the declared self-secrets during provision/claim; boot fetches
   them using the app keystore, into memory only. Never make or copy a secret in a shell or
   env file. For an already-claimed app, use `/jin` **Sync manifest secrets** and countersign
   before restarting. For kernel
   notifications set the non-secret `AUTH_SERVICE_URL` (kernel auth URL including `/auth`).
   `pnpm check-env` checks the required auth config in the process environment without
   reading a keystore or requiring any self-secret in env.
4. **Migrate this app's own database** (its own Postgres schema only — see
   [`docs/MIGRATIONS.md`](./docs/MIGRATIONS.md)):
   ```bash
   pnpm install
   pnpm db:migrate
   ```
5. **Run it**:
   ```bash
   pnpm dev
   ```
   `/api/health` and `/api/spec` should respond immediately; `/api/me` returns your DID once
   you sign in through the header's "Sign in with Imajin" link.

## Creating a new app (with template history)

> **Do not use GitHub's "Use this template" button.** It creates a repo with a brand-new, unrelated root
> commit. Such an app can never merge template changes cleanly — its first sync is an
> `--allow-unrelated-histories` merge with add/add conflicts on nearly every file (that's why `/claim` had to be
> hand-ported into `links` and `dykil`). Instead, keep the template's history as the app's ancestry:

```bash
# 1. Clone the template under your app's name; the template becomes the `template` remote.
git clone https://github.com/ima-jin/imajin-app-template.git <app-name>
cd <app-name>
git remote rename origin template

# 2. Create the (empty) app repo on GitHub and make it `origin`. No README/license/.gitignore — it must be empty.
gh repo create ima-jin/<app-name> --private --source=. --remote=origin --push

# 3. Rename the template identity (one commit), then push.
#    package.json "name", api-spec/openapi.yaml (title + example), app/api/health/route.ts (+ its test),
#    app/layout.tsx description, sonar-project.properties (projectKey), the README title, and AGENTS.md §8.
git checkout -b chore/rename-app
# ...edit the files above...
git commit -am "chore: rename template → <app-name>" && git push -u origin chore/rename-app
```

Because the app was cloned from the template, `git merge-base HEAD template/main` finds a common ancestor from
the very first commit — there is nothing to "join".

### Pulling template changes later

```bash
scripts/sync-from-template.sh --check   # list pending template commits; no merge, no branch
scripts/sync-from-template.sh           # merge template/main onto chore/sync-from-template → open a PR
```

The script adds the `template` remote if missing, fetches `template/main`, and checks for a common ancestor:

- **Histories joined** → prints `histories already joined; incremental merge` and runs a normal
  `git merge template/main --no-edit` on a `chore/sync-from-template` branch (never straight to `main`).
- **Not joined** (app created with "Use this template") → exits with status 2 and prints the one-time join. The
  join is history-only — it changes **no files**:
  ```bash
  git checkout -b chore/join-template-history
  git merge -s ours --allow-unrelated-histories <template-sha> -m "chore: join template history (one-time)"
  ```
  Use the template commit the app was **generated from** (the template's state when the app repo was created),
  not `template/main`: `-s ours` marks everything up to that commit as already merged, so joining at the tip
  would silently skip every template change since the app was created. After the join PR merges, the script
  reports `histories already joined` and pulls later template changes as an ordinary merge.

On a conflict (almost always AGENTS.md §8, or the renamed identity files from step 3), keep your version of
what is yours and take the template's side of the shared contract.

## Consuming `@ima-jin/*`

Published `@ima-jin/*` packages (e.g. `@ima-jin/auth-client`, `@ima-jin/config`, `@ima-jin/ui`) are served from
npmjs.org, the default registry — no `.npmrc` scoping and no auth token needed to install them:

```bash
pnpm add @ima-jin/auth-client
```

CI proves this on every PR (`Clean registry install` in `ci.yml`): a from-scratch, cache-less install must succeed,
and no dependency may resolve through a `workspace:`/`link:`/`file:` specifier or the monorepo's unpublished `@imajin/*`
scope.

## CI gates

Every PR runs: lint / typecheck / test / build, the clean registry install, a dependency-advisory gate
(`Security Audit`), the migrations ownership check (`Check Migrations`), SonarCloud, and CodeQL. All third-party
actions are pinned by commit SHA and installs use `--ignore-scripts`. What each gate enforces, and how to run it
locally, is in [AGENTS.md §6](./AGENTS.md#6-ci-gates--the-bar-every-pr-must-clear).

## Layout

```
AGENTS.md          ← boundary + scope for coding agents (read first)
README.md          ← this file
docs/
  ARCHITECTURE.md  ← design notes
  REGISTRATION.md  ← how to register this app with the kernel
  MIGRATIONS.md    ← this app's schema-ownership rule (enforced by check-migrations.yml)
  DEPLOY.md        ← pm2 entry + Caddy route convention, deploy sequence, rollback
app/               ← Next.js App Router: pages + API routes
src/
  components/      ← client components
  lib/             ← auth config, signing-identity (loadAppSigningKey boot path), base-path, other helpers
  db/              ← this app's own drizzle schema (never a kernel schema)
migrations/        ← generated by `pnpm db:generate`, applied by `pnpm db:migrate`
scripts/           ← CI gate CLIs (audit-gate, check-migrations, check-registry-deps) + their unit-tested lib/, template sync
.github/           ← workflows (CI, Security Audit, Check Migrations, SonarCloud) + audit-baseline.json — see AGENTS.md §6
api-spec/          ← this app's own OpenAPI document, served at /api/spec
instrumentation.ts ← boot-env guards + loadAppSigningKey() bootstrap (see docs/REGISTRATION.md)
imajin.app.json    ← registered-app self-secret recipes (names and kinds only)
middleware.ts      ← gates every route on claim state — unclaimed page, /claim 404 once claimed (#2427)
```

`app/claim/page.tsx` + `app/api/claim/route.ts` are the operator-facing claim page and its server
route (#2427) — see "This app's own signing key" below.

## This app's own signing key
Operators claim this app in the browser at its `/claim` page.

This app never reads a raw private key from env. `instrumentation.ts` fails loud at boot if
`IMAJIN_APP_PRIVATE_KEY` is set, and instead calls `@ima-jin/auth-client`'s `loadAppSigningKey()`.
Without a keystore yet, this app boots in **unclaimed mode** (#2427): every route
except `/claim`, `/api/claim`, and `/api/health` serves a minimal "not claimed yet" page. The
operator path: approve provisioning on the kernel's `/jin` → open `<this app>/claim` → paste the
one-time claim code → done — no ssh, no env edit, no restart. This is the only claim path; it bootstraps
a local `0600` keystore (`IMAJIN_APP_KEYSTORE`); every later boot re-authenticates with that
keystore, no operator action needed. See
[`docs/REGISTRATION.md`](./docs/REGISTRATION.md#4-claim-this-apps-own-signing-key-7-2427).

## Declared self-secrets

`imajin.app.json` declares this app's session-signing recipe. After retrieving the signing
identity, `src/lib/self-secrets.ts` awaits `@ima-jin/auth-client@0.8.18`'s app-keystore
`loadFromVault()` before the app becomes usable. Session routes read the resulting memory
slot lazily, even across Next.js bundles. Env credentials are never used as a fallback.
Unclaimed mode still serves only the claim/health surfaces; successful browser claim loads
the declarations before adopting the identity.

To add another self-secret, add a `{ "name": "YOUR_SECRET_NAME", "kind": "random-32B" }`
recipe (`random-64B` is also supported) to the manifest, then use `getSelfSecret('YOUR_SECRET_NAME')`
server-side at request time. The boot module loads every declaration with `onMissing: 'fail'`
and publishes only after all succeed. Do not add it to env or expose it to the browser.
Provision/claim issues and seals new recipes; for an existing app, select **Sync manifest secrets**
on `/jin` and countersign the proposal, then restart. If a declared secret is unavailable,
boot fails closed with one value-free operator instruction naming it.

To rotate, select **Rotate** on `/jin`, countersign, and restart through the approved operator
tool. The next boot picks up the new value without an env/file edit. Session rotation invalidates
old cookies, so users sign in again. No values are printed, persisted or copied.

## Mounting under a path prefix

Set `NEXT_PUBLIC_BASE_PATH` (e.g. `/coffee`) when this fork is served behind a reverse-proxy path
prefix instead of at `/`. `next.config.js` reads it for Next's own `basePath` (covers `<Link>` and
`router.push` automatically); route any raw `fetch()`, `<a href>`, or `redirect()` through
`src/lib/base-path.ts`'s `withBasePath()` helper, since Next.js doesn't rewrite those.

## Kernel notifications: the kernel signs, the app verifies

`POST /api/webhooks/kernel` is the one minimal example receiver. It uses
`verifyKernelWebhook` from the public, exactly pinned `@ima-jin/auth/kernel-webhook` SDK
0.8.18 before parsing or calling `src/lib/kernel-notification.ts`. There is no shared callback
credential or Bearer fallback. The expected audience is this deployment's `IMAJIN_APP_DID`,
not the scoped-token slug or a request-supplied value. Public discovery uses `AUTH_SERVICE_URL`.
Ship the receiver only after the kernel signs on that same environment — see [Deploy order](./docs/DEPLOY.md#deploy-order).

In your fork, replace `handleKernelNotification`'s no-op with your own domain handler. Its input
is `unknown`: validate the JSON shape before effects, then implement business idempotency for
freshly signed retries. The template acknowledges valid JSON with `{ received: true }` but
intentionally performs no payment, settlement or enrollment work. Claim the app first; the
existing unclaimed middleware still gates this route. See [the operator requirements](./docs/DEPLOY.md#kernel-signed-notifications)
for public pins, replay storage, rotation and proxy path preservation.

## The honest test

Every Imajin app before the external integrators was first-party (same repo, same server, privileged access). Apps
built from this template are the **external-integrator** test: if this app can do everything it needs through app-auth
and the public API alone, the federated-app boundary is real.

