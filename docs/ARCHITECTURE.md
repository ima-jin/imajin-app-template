# Architecture — &lt;App Name&gt;

> This app is a **lens** over the user's signed records. It owns no authoritative state. See `AGENTS.md` §1–§3.

## The three-tier projection model

| Tier | What | Owns truth? |
|------|------|-------------|
| **User's signed records** | signed markdown/attestations on the user's per-DID path (hosted now, user-held vault later) | ✅ source of truth |
| **Kernel domain core** | domain events / stage tables / settlement primitive | ❌ derived projection |
| **Connectors** | user-selected services (QuickBooks, …) feeding the user's records | ❌ user's instruments |
| **This app** | render + gesture UX + connector-select | ❌ a lens |

## Integration contract

External client only — app-auth headers (`X-App-DID` + `X-App-Authorization`) → kernel returns
`{ appDid, userDid, scopes }`. No `workspace:*` deps, no monorepo internals, no DB, no in-process bus. Published
`@ima-jin/*` SDK packages (npmjs.org, no auth needed) are fine — see `AGENTS.md` §2. Domain events are emitted by calling the
kernel's app-auth-gated domain API.

## Deploy convention

Each fork deploys as its own pm2 ecosystem entry behind a Caddy route (path prefix → this app's port), the same
shape as every other app on the platform. The full convention — deploy sequence, `ecosystem.config.cjs`, Caddy
snippet, rollback — is in [`DEPLOY.md`](./DEPLOY.md). No deploy workflow ships with the template: a deploy needs the
host's runner and secrets, so wire your own against your fork's infra when you're ready to ship; the convention only
fixes the shape (one pm2 entry, one Caddy route per environment) so it stays consistent across apps.

## The loop this app instruments

_<Describe the real-world loop: who hands what to whom, which single leg is paid (`.fair`), and how the gesture becomes
a signed record without adding friction.>_

## Open decisions

_<Running list of design decisions still to lock.>_
