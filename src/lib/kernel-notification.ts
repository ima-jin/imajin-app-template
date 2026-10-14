/**
 * Forks wire their payment/settlement/enrollment handler here.
 * Signature verification authenticates the sender, not the payload schema:
 * validate the unknown JSON and enforce business idempotency before effects.
 * This template deliberately acknowledges without domain effects.
 */
export function handleKernelNotification(payload: unknown): unknown {
  // Replace this no-op with your app's handler, not with authentication logic.
  return payload;
}
