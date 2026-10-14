/** Non-secret auth config only. Credentials are declared in imajin.app.json. */
export const REQUIRED_APP_ENV = ['IMAJIN_AUTH_URL', 'IMAJIN_KERNEL_URL', 'NEXT_PUBLIC_IMAJIN_APP_ID'];

/**
 * Same guard used by instrumentation and check-env; never prints env values.
 * @param {Record<string, string | undefined>} env
 */
export function validateRequiredBootEnv(env = process.env) {
  const missing = REQUIRED_APP_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set the non-secret config — see .env.example and docs/REGISTRATION.md.'
    );
  }
}
