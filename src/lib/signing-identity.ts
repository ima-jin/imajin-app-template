import {
  loadAppSigningKey,
  readKeystore,
  resolveKeystorePath,
  type AppSigningKey,
} from '@ima-jin/auth-client';

/**
 * This app's own vault signing key (#7, #2427, mirrors `ima-jin/imajin-ai`'s
 * `loadAppSigningKey()` boot path — see `@ima-jin/auth-client`'s README,
 * "Fetch this app's own signing key at boot", and `docs/REGISTRATION.md`).
 *
 * Populated once by `bootstrapSigningIdentity()`, called from
 * `instrumentation.ts` before this app serves any request — or later, by
 * `claimWithCode()`, called from the operator-facing `/claim` page's server
 * route (`app/api/claim/route.ts`) once an operator pastes a claim code in
 * the browser instead of an env file. Memory-only for the life of this
 * process — never written to disk, another env var, or a log line.
 * `@ima-jin/auth-client` itself only ever persists the narrow-purpose
 * bootstrap keypair on disk (`IMAJIN_APP_KEYSTORE`, `0600`), never this
 * signing key.
 */
let signingIdentity: AppSigningKey | null = null;

/**
 * True once this app has a real, vault-minted signing identity in memory —
 * either from this boot's `bootstrapSigningIdentity()` or from a later
 * `claimWithCode()` hot-swap. False in "unclaimed boot mode" (#2427): the
 * app booted without throwing because neither a bootstrap keystore nor an
 * `IMAJIN_APP_CLAIM_CODE` was present yet.
 */
export function isAppClaimed(): boolean {
  return signingIdentity !== null;
}

/**
 * True when `loadAppSigningKey()` has real material to exchange this boot —
 * an existing bootstrap keystore (every later boot) or a one-time claim
 * code (first boot only). Mirrors the SDK's own precondition check so this
 * module can decide to boot unclaimed *without* calling it at all, rather
 * than parsing its thrown error message.
 */
function hasClaimMaterial(): boolean {
  const keystorePath = resolveKeystorePath(process.env.IMAJIN_APP_KEYSTORE);
  return readKeystore(keystorePath) !== null || Boolean(process.env.IMAJIN_APP_CLAIM_CODE);
}

/**
 * Fetches this app's own signing key from the kernel — via the local
 * bootstrap keystore when one already exists, or via a one-time claim code
 * on first boot (see `@ima-jin/auth-client`'s `loadAppSigningKey()`).
 *
 * Unclaimed boot mode (#2427): when neither a keystore nor
 * `IMAJIN_APP_CLAIM_CODE` is present, this returns without throwing instead
 * of crashing boot — the app serves the "not claimed yet" page
 * (`middleware.ts`) until an operator pastes a code at `/claim`. Any *real*
 * failure (kernel refused a code that was actually provided, network error,
 * …) still throws — a misconfigured deploy should fail loud, not run
 * silently unsigned.
 */
export async function bootstrapSigningIdentity(): Promise<void> {
  if (!hasClaimMaterial()) {
    return;
  }
  signingIdentity = await loadAppSigningKey();
}

/** Returns the signing identity bootstrapped by `bootstrapSigningIdentity()` or `claimWithCode()`. */
export function getSigningIdentity(): AppSigningKey {
  if (!signingIdentity) {
    throw new Error(
      'getSigningIdentity: signing identity not bootstrapped yet — instrumentation.ts must run first, ' +
        'or this app has not been claimed yet (see /claim).'
    );
  }
  return signingIdentity;
}

export interface ClaimWithCodeParams {
  /** The one-time claim code the operator pasted into `/claim`. */
  claimCode: string;
  /** Best-effort label (e.g. request origin) recorded on the kernel's /jin timeline only. */
  hostHint?: string;
}

/**
 * Redeems a one-time claim code submitted through the operator `/claim`
 * page (`app/api/claim/route.ts`) — the browser-paste path #2427 adds
 * alongside the existing `IMAJIN_APP_CLAIM_CODE` env-var path. Delegates to
 * the same `@ima-jin/auth-client`'s `loadAppSigningKey()` first-boot
 * exchange, so the bootstrap keypair is persisted to the same `0600`
 * keystore either way. Hot-swaps this process's in-memory signing identity
 * immediately — no restart required, though a restart also works (it just
 * re-reads the now-present keystore).
 */
export async function claimWithCode(params: ClaimWithCodeParams): Promise<AppSigningKey> {
  const identity = await loadAppSigningKey({ claimCode: params.claimCode, hostHint: params.hostHint });
  signingIdentity = identity;
  return identity;
}

/** Test-only: clears the in-memory signing identity between test cases. */
export function resetSigningIdentityForTests(): void {
  signingIdentity = null;
}
