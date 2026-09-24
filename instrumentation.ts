/**
 * Next.js instrumentation hook (stable since Next 15) — runs once when the
 * server process starts, before it serves any request. Not invoked by
 * `next build`, so CI builds are not gated on runtime secrets.
 *
 * This app is registered with the Imajin kernel (see docs/REGISTRATION.md)
 * and is identified by its own DID. Refusing to boot without it catches a
 * misconfigured deploy immediately instead of serving requests no kernel
 * call can ever authenticate.
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  if (!process.env.IMAJIN_APP_DID) {
    throw new Error(
      'IMAJIN_APP_DID is not set. Register this app with the kernel first — see docs/REGISTRATION.md.'
    );
  }
}
