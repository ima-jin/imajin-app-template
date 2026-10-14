import { loadFromVault } from '@ima-jin/auth-client';
import manifest from '../../imajin.app.json';

// Next compiles instrumentation and routes separately. Share memory, not env
// or a disk cache, across those bundle copies in the same server process.
const SELF_SECRETS_KEY = Symbol.for('imajin.app.selfSecrets');

interface SelfSecretsStore {
  [SELF_SECRETS_KEY]?: Readonly<Record<string, string>>;
}

export class SelfSecretsUnavailableError extends Error {
  constructor() {
    super('App self-secrets unavailable');
    this.name = 'SelfSecretsUnavailableError';
  }
}

export function clearSelfSecrets(): void {
  delete (globalThis as SelfSecretsStore)[SELF_SECRETS_KEY];
}

/** Load only manifest declarations using this app's bound bootstrap keystore. */
export async function bootstrapSelfSecrets(appDid: string): Promise<void> {
  clearSelfSecrets();
  const values: Record<string, string> = Object.create(null);
  for (const { name } of manifest.secrets) {
    try {
      // One required declaration per call lets a value-free SDK error be
      // attributed precisely, including when forks add more declarations.
      const credentials = await loadFromVault({
        appDid,
        kernelUrl: process.env.IMAJIN_KERNEL_URL,
        keystorePath: process.env.IMAJIN_APP_KEYSTORE,
        keys: [{ key: name, onMissing: 'fail' }],
        fetchOptions: { signal: AbortSignal.timeout(15_000) },
      });
      const value = credentials.values[name];
      if (typeof value !== 'string' || !value.trim()) {
        throw new SelfSecretsUnavailableError();
      }
      values[name] = value;
    } catch {
      // Never log an SDK/provider error, response body, or credential value.
      console.error(
        `Self-secret ${name} unavailable. On /jin select Sync manifest secrets, ` +
          'sign the proposal, then restart this app; check kernel connectivity if re-sync fails.'
      );
      throw new SelfSecretsUnavailableError();
    }
  }
  // Publish atomically: a partial or failed load cannot serve signed sessions.
  (globalThis as SelfSecretsStore)[SELF_SECRETS_KEY] = Object.freeze(values);
}

export function getSelfSecret(name: string): string {
  const value = (globalThis as SelfSecretsStore)[SELF_SECRETS_KEY]?.[name];
  if (!value) {
    throw new SelfSecretsUnavailableError();
  }
  return value;
}
