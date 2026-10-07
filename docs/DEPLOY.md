# Deploying an app built from this template

Every app built from this template deploys the same way: **its own repo, checked out on the kernel host, run as its
own pm2 process, behind the host's Caddy.** Nothing outside this repo builds, migrates or restarts it. This document
fixes the *shape* (one pm2 entry per environment, one Caddy route per environment, one deploy sequence) so every
app looks the same to the operator; it deliberately ships **no deploy workflow** — a deploy needs the host's runner,
SSH access and secrets, which belong to whoever operates that host, not to the template.

Replace `<app>` with your app's slug (the repo name, e.g. `coffee`) and pick a port pair no other app on the host
uses. `<app>` is also your `NEXT_PUBLIC_BASE_PATH` (`/<app>`) when the app is mounted under the kernel host's domain.

## The convention

| | dev | prod |
|---|---|---|
| pm2 process | `dev-<app>` | `prod-<app>` |
| Checkout on the server | `~/dev/<app>` | `~/prod/<app>` |
| Local port | `3xxx` (next free dev port) | `7xxx` (next free prod port) |
| Public URL | `https://dev-jin.imajin.ai/<app>` | `https://jin.imajin.ai/<app>` |
| Health | `http://127.0.0.1:<dev port>/<app>/api/health` | `http://127.0.0.1:<prod port>/<app>/api/health` |
| Env file | `~/dev/<app>/.env.local` | `~/prod/<app>/.env.local` |

Record your app's pair in AGENTS.md §8 (Domain) so the next app does not collide. Dev and prod are **separate
checkouts with separate identities**: each has its own app DID, claim code and keystore
([REGISTRATION.md](./REGISTRATION.md)), its own `.env.local`, and — if the app owns a database — its own
`DATABASE_URL`.

## The deploy sequence

Run from the target's own checkout on the server. Every step is fail-fast: any failure before the restart leaves the
running process serving the previous build.

1. **preflight** — `git`, `node` (>= `.nvmrc`), `pnpm`, `pm2` and `curl` on `PATH`; no local changes to tracked
   files; `.env.local` exists; no pm2 entry of the same name pointing at a *different* path (pm2 would "reload" it
   with the old script and cwd).
2. **checkout** — `git fetch --tags --prune origin`, then `git checkout --detach <ref>` (default `origin/main`).
   Never `git pull` on the host: it skips every other step here and leaves a stale build serving.
3. **install** — `pnpm install --frozen-lockfile --ignore-scripts` (the same flags CI uses; nothing in the app needs a
   dependency lifecycle script).
4. **build** — `node --env-file=.env.local node_modules/next/dist/bin/next build`. The env file is loaded so
   `NEXT_PUBLIC_*` values are baked into the build; changing one means rebuilding.
5. **migrate** — `pnpm db:migrate`, **only if the app owns a database**. It applies `migrations/` to this app's own
   schema (`APP_DB_SCHEMA`) and nothing else — see [MIGRATIONS.md](./MIGRATIONS.md). An app that owns no database
   skips this step.
6. **restart** — `pm2 startOrReload ecosystem.config.cjs --only <prod|dev>-<app> --update-env`, then `pm2 save`.
7. **health** — poll `/<app>/api/health` for up to ~60 s and require `"status":"ok"`. A healthy but unclaimed app
   (`"claimed":false`) is the expected state on an environment's first deploy: the identity is minted by an operator
   at `<app>/claim`, never by the deploy.

The env file is the single source of truth. `node --env-file` and `pm2 --update-env` both let the *calling shell's*
environment win over the file, so a stray `DATABASE_URL` exported in the deployer's shell would silently point the
build, the migration and the pm2 process at the wrong database. Unset the app's contract variables (the names in
`.env.example`) before deploying, or deploy from a clean shell.

**Rollback** is a redeploy of the previous tag or sha (`--detach` checkout, same sequence). Migrations only ever move
forward: a release that ships a migration must stay compatible with the previous build, or the rollback has to be
a forward-fix.

## pm2: one entry per environment

Copy this as `ecosystem.config.cjs` at the repo root and fill in the slug and ports. One file, two entries; a
checkout only ever starts its own (`--only`).

```js
// pm2 ecosystem for <app>. One file, two entries; each server checks the repo
// out once per environment and starts only its own:
//   pm2 startOrReload ecosystem.config.cjs --only prod-<app> --update-env
const path = require('node:path');
const os = require('node:os');

const root = __dirname;
const logDir = path.join(os.homedir(), '.pm2', 'logs');

function app(name, port) {
  return {
    name,
    cwd: root,
    // Exec the Next listener directly — never `script: 'npm', args: 'start'`.
    // pm2 would track the npm wrapper, and on restart the `next-server`
    // grandchild survives, keeps the port bound, and the fresh copy
    // crash-loops on EADDRINUSE.
    script: 'node_modules/next/dist/bin/next',
    args: `start -p ${port}`,
    interpreter: 'node',
    // Node exits if the file is missing — deliberate: an app that cannot load
    // its env must crash loudly, not boot without its identity. Secrets stay
    // in the untracked .env.local; only its path is versioned.
    node_args: `--env-file=${path.join(root, '.env.local')}`,
    exec_mode: 'fork',
    env: { PORT: port, NODE_ENV: 'production' },
    out_file: path.join(logDir, `${name}-out.log`),
    error_file: path.join(logDir, `${name}-error.log`),
    time: true,
    max_restarts: 10,
    min_uptime: '20s',
  };
}

module.exports = {
  apps: [app('prod-<app>', 7xxx), app('dev-<app>', 3xxx)],
};
```

`cwd` is the file's own directory, so the config is correct wherever the checkout lives and never hard-codes a home
directory. Logging is stdout only; pm2 captures it:

```bash
pm2 logs prod-<app> --lines 100
pm2 describe prod-<app>
```

## Caddy: one route per environment

The app is mounted under the `/<app>` basePath (`NEXT_PUBLIC_BASE_PATH=/<app>`, see the README's "Mounting under a
path prefix"), and Caddy must forward the prefix **intact** — use `handle`, not `handle_path` (which strips it).
Caddy's `reverse_proxy` appends the real peer to `X-Forwarded-For`, which the `/claim` rate limit relies on
([REGISTRATION.md](./REGISTRATION.md), "Proxy trust assumption"); keep the app port bound to localhost so nothing
can reach it around the proxy.

```caddy
# prod — inside the existing jin.imajin.ai site block
jin.imajin.ai {
    @<app> path /<app> /<app>/*
    handle @<app> {
        reverse_proxy localhost:7xxx
    }
    # ...the rest of the site unchanged
}

# dev — inside the existing dev-jin.imajin.ai site block
dev-jin.imajin.ai {
    @<app> path /<app> /<app>/*
    handle @<app> {
        reverse_proxy localhost:3xxx
    }
}
```

Verify: `curl -fsS https://jin.imajin.ai/<app>/api/health` returns `{"status":"ok",…}`.

## Operator steps a deploy cannot do

- **Mint the app identity**, once per environment, through the kernel's claim flow — the runbook is in
  [REGISTRATION.md](./REGISTRATION.md): register, approve provisioning on `/jin`, put the resulting `IMAJIN_APP_DID`
  in `.env.local`, deploy, then paste the claim code on `<app>/claim`. No hand-made keys, no key material in logs.
  Do not lose the keystore: a lost keystore needs a fresh claim code.
- **Create the app's database role** (if it owns a schema) scoped to `APP_DB_SCHEMA`, and put the connection string
  in `.env.local`. Never a kernel database role.
- **Add the Caddy route** above to the host's site block.

## Troubleshooting

- **Health never goes green on a first boot** — `pm2 logs <name>`: a used or rejected claim code, a wrong
  `IMAJIN_APP_DID`, or a leftover raw `IMAJIN_APP_PRIVATE_KEY` fails at `instrumentation.ts`. Dev and prod must each
  have their own DID, claim code and keystore.
- **Health reports `claimed:false`** — the app booted but is unclaimed: open `<app>/claim` and paste the claim code.
- **pm2 reloads the wrong code** — a same-named entry points at another path. `pm2 delete <name> && pm2 save`, then
  redeploy. Removing a stale entry is deliberately never automatic.
- **`EADDRINUSE` on restart** — the entry execs `npm start` instead of the Next listener directly; use the
  `ecosystem.config.cjs` above.
