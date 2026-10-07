import pkg from '../../package.json';

/**
 * This app's registry slug — the `aud` its scoped app tokens are minted for.
 *
 * `apps.provision` registers the slug (the repo name) in
 * `registry.apps.token_audiences`, and the fork's rename step sets
 * `package.json` `name` to that same slug, so this needs no edit after
 * provisioning. NEVER derive the audience from this app's host: every
 * path-routed app shares `jin.imajin.ai` / `dev-jin.imajin.ai`, so a host
 * audience would let apps accept each other's tokens (imajin-ai#2706).
 * `@ima-jin/auth` also honours an `IMAJIN_APP_AUD` override.
 */
export const APP_SLUG: string = pkg.name;
