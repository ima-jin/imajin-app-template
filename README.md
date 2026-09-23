# &lt;App Name&gt; — a third-party app on Imajin

> Forked from [`ima-jin/imajin-app-template`](https://github.com/ima-jin/imajin-app-template). **Read
> [`AGENTS.md`](./AGENTS.md) first** — it defines the boundary this app must not cross.

**Platform:** [Imajin](https://imajin.ai) (sovereign-tech kernel) · **Reference app:** `ima-jin/imajin-scorecard`

This repository **is the app** — a real, arms-length third-party application that composes the Imajin platform
**only through its public app surface** (`requireAppAuth` + the documented kernel API). It holds **no `workspace:*`
deps, no monorepo internals, no DB access, no in-process bus** — it talks to Imajin as an external client. Published
`@imajin/*` SDK packages (from GitHub Packages, see `.npmrc`) are fine to depend on; they're the same versioned
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

```bash
cp .env.example .env      # fill in KERNEL_URL, APP_DID, APP_PRIVATE_KEY, SESSION_SECRET
npm install
npm run dev
```

## Consuming `@imajin/*`

Published `@imajin/*` packages are served from GitHub Packages, not npmjs.org. The scope is already pinned in the
committed [`.npmrc`](./.npmrc) (`@imajin:registry=https://npm.pkg.github.com`); it reads the auth token from
`NODE_AUTH_TOKEN` — that variable is never committed.

- **Locally:** create a [GitHub personal access token](https://github.com/settings/tokens) with the `read:packages`
  scope, then export it before installing:
  ```bash
  export NODE_AUTH_TOKEN=ghp_your_token_here
  npm install
  ```
- **In CI (GitHub Actions):** no PAT needed — the workflow's own ephemeral `GITHUB_TOKEN` can read packages as long
  as the job grants it, e.g.:
  ```yaml
  permissions:
    packages: read
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version-file: .nvmrc
    - run: npm install
      env:
        NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  ```

## Layout

```
AGENTS.md   ← boundary + scope for coding agents (read first)
README.md   ← this file
docs/        ← ARCHITECTURE.md + design notes
src/         ← the app (Next.js)
```

## The honest test

Every Imajin app before the external integrators was first-party (same repo, same server, privileged access). Apps
built from this template are the **external-integrator** test: if this app can do everything it needs through app-auth
and the public API alone, the federated-app boundary is real.
