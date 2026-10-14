# Registering this app with the kernel

Per ima-jin/imajin-ai#1990, the kernel refuses to serve an unregistered app: every app is an
identity — a row in the kernel's app registry — before it can compose the platform. This app
**refuses to start** without `IMAJIN_APP_DID` set (see `instrumentation.ts`), so registration
is the first thing a fork must do, before `pnpm dev`.

## 1. Register and provision through the operator tools

Use the approved kernel provisioning tool and the operator's `/jin` approval card.
Review the app's name, callback URL, requested scopes and `imajin.app.json` recipes,
then countersign the proposal. The kernel issues and seals this app's signing identity
and declared self-secrets; the operator never generates, reveals or copies their values.
Record only the public `appDid` and registry `id` in the non-secret app configuration.
Complete the existing browser claim step below to establish this app's bootstrap keystore.

Do not issue or transfer key material through a shell command. This template never reads
a raw private key from env (`instrumentation.ts` fails loud if `IMAJIN_APP_PRIVATE_KEY`
is set); the published SDK authenticates with the local keystore after claim.

## 2. Fields, and what they mean for a fork

| Field | Meaning |
|---|---|
| `appDid` | This app's own `did:imajin:…`, derived from its public key. Set as `IMAJIN_APP_DID`. |
| `ownerDid` | The developer DID that registered the app (you). Not needed as an env var. |
| `tier` | Always `third_party` for self-service registration. `first_party` is reserved for the kernel's own admin surface — every app forked from this template, including Imajin's own extractions (dykil, links, …), registers the same way, at the same tier. |
| `requestedScopes` | Clamped server-side to the kernel's declarative scope vocabulary — you cannot register an ad-hoc scope string. |
| `allowedRedirectHosts` | Seeded from `callbackUrl`'s origin. The kernel will only ever redirect a signed-in user back to a host in this set. |
| `tokenAudiences` | This app's slug (`apps.provision` writes `[slug]`; no post-provision edit). **Never the shared host** (`jin.imajin.ai` / `dev-jin.imajin.ai`) — every path-routed app shares it, so apps would accept each other's tokens (imajin-ai#2706). Scoped app tokens (`Authorization: Bearer`, e.g. agents / MCP clients) are verified by `authenticate()` (`src/lib/auth/authenticate.ts`, `@ima-jin/auth`'s `requireSessionOrAppToken`) against this slug — `APP_SLUG` in `src/lib/app-slug.ts` is `package.json` `name`, which the rename step sets to the slug; `IMAJIN_APP_AUD` overrides it. Irrelevant to the session/cookie flow (`getSession`, the `/api/auth/*` routes). |

`id` (the `app_...` registry id, not the DID) is what you set as `NEXT_PUBLIC_IMAJIN_APP_ID` —
it's what the "Sign in with Imajin" redirect uses client-side.

## 3. Wire up this app

```bash
cp .env.example .env.local
# fill in:
#   IMAJIN_APP_DID=<public appDid from provisioning>
#   NEXT_PUBLIC_IMAJIN_APP_ID=<public registry id from provisioning>
#   APP_DB_SCHEMA=<a name for this app's own Postgres schema — see docs/MIGRATIONS.md>
#   DATABASE_URL=<this app's own Postgres connection string>
#   IMAJIN_KERNEL_URL=<same host as IMAJIN_AUTH_URL above>
```

The kernel issues and seals the names/kinds declared in `imajin.app.json` on provision/claim.
For an already-claimed app, select **Sync manifest secrets** on `/jin` and countersign the
proposal, then restart. Never generate, view or copy a secret in a shell or between env files.
Env holds the keystore path, database connection, kernel URLs and non-secret config only.

Without `IMAJIN_APP_DID` set, or with a raw `IMAJIN_APP_PRIVATE_KEY` still set, `pnpm dev` /
`pnpm start` throw immediately (`instrumentation.ts`) instead of serving requests no kernel call
could ever authenticate.

## 4. Claim this app's own signing key (#7, #2427)

This app never reads a raw private key out of `.env`. Instead it fetches its own vault-minted
signing key from the kernel, via `@ima-jin/auth-client`'s `loadAppSigningKey()`
(`src/lib/signing-identity.ts`). Claim only through this app's browser page:

### The operator path: paste the code in the browser

1. The kernel operator approves this app's provisioning on `/jin`. The approval card reveals a
   one-time claim code.
2. Open `<this app's URL>/claim` in a browser (`/<slug>/claim` for a path-mounted app).
3. Paste the claim code and submit. The server verifies the returned app DID against
   `IMAJIN_APP_DID` before adopting the identity.

That's it — no ssh, no env file edit, no restart. Behind the scenes, this app's own
`app/api/claim/route.ts` calls the kernel's `POST /api/apps/claim` on your behalf, writes the
local bootstrap keystore (`IMAJIN_APP_KEYSTORE`, default `./.imajin/keystore.json`, mode `0600`),
and loads all declared self-secrets through that keystore before adopting the in-memory signing
identity — the app is claimed without a restart
(though a restart also works fine afterwards). `/claim` 404s once this succeeds; the code is spent
and cannot be reused.

This is only possible because this app boots in **unclaimed mode** when no keystore
is present: instead of crashing at boot, every route except `/claim`,
`/api/claim`, and `/api/health` serves a minimal "not claimed yet" page, and `/api/health` reports
`{ claimed: false }`.

### Proxy trust assumption (rate limiting on `/claim`)

`POST /api/claim` is rate limited per client address, and the only address it trusts is the
**last** hop of `X-Forwarded-For` — the one appended by this app's own front door. That is only
sound if both of these hold:

- **The front door must set `X-Forwarded-For`.** Caddy's `reverse_proxy` does this by default
  (with no `trusted_proxies` configured, it discards any client-supplied value and appends the
  real peer address). Any other proxy must be configured to do the same. `x-real-ip` is never
  consulted — a proxy does not overwrite it, so it is fully client-controlled.
- **The app port must not be directly reachable.** Bind it to localhost or a private network
  and firewall it, so every request arrives through the front door. A client that can reach the
  port directly can send any `X-Forwarded-For` it likes and sidestep the per-address limit.

Without a usable `X-Forwarded-For`, all callers share one coarse fallback bucket.

### Every later boot

Once a keystore exists (from the claim page), every later boot signs a fresh challenge with the
persisted bootstrap key and fetches the signing key again — no claim code needed, no operator
action required for an ordinary restart.
The boot module then awaits the published app-keystore `loadFromVault()` for every manifest
declaration before serving sessions. Values stay in process memory, never env, disk or logs.
An unavailable declaration fails closed with one log line naming it and the `/jin` re-sync
step; there is no env fallback. After **Rotate** + countersign on `/jin`, restart through the
approved operator tool to fetch the new generation without editing a file. Session rotation
invalidates existing cookies. To declare another recipe, see
[Declared self-secrets](../README.md#declared-self-secrets).

If the local keystore is ever lost (disk wipe, redeploy to a fresh host), ask the kernel operator
to re-approve `apps.provision` with `reissueClaim: true` for a fresh claim code. Redeem it at
`<this app's URL>/claim` — redeeming it also
revokes the lost keystore's bootstrap key. See `@ima-jin/auth-client`'s README for the full API.

## 5. List or manage your apps later

Use the kernel's public developer/app tools to inspect registry metadata.
Manage declared self-secrets on `/jin`: **Sync manifest secrets**, **Rotate** or **Revoke**,
review the proposal and countersign. Restart through the approved operator tool after
rotation; do not change an env file or copy a credential. A revoked boot-required
secret prevents the next claimed boot; re-sync does not resurrect it.

## Kernel notifications

The kernel signs and the app verifies with `verifyKernelWebhook` from the published SDK.
Configure this deployment's public `IMAJIN_APP_DID` and `AUTH_SERVICE_URL` (including `/auth`);
no callback credential is generated, provisioned or exchanged. Register your fork's callback
destination through the kernel's public app/tool surface, preserving its external path prefix.
Wire your own handler as described in [the README](../README.md#kernel-notifications-the-kernel-signs-the-app-verifies).
See [Deploy](./DEPLOY.md#kernel-signed-notifications) for discovery, trust and replay requirements.
