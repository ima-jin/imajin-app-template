import { KernelWebhookError, verifyKernelWebhook } from '@ima-jin/auth/kernel-webhook';
import { handleKernelNotification } from '@/lib/kernel-notification';

export const runtime = 'nodejs';

/** Example kernel receiver: never add a shared Bearer authentication fallback. */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    // Verify exact bytes before parsing or effects. The expected audience is
    // this deployment's own DID, never a value supplied by the request.
    payload = await verifyKernelWebhook(request, {
      audience: process.env.IMAJIN_APP_DID ?? '',
      authServiceUrl: process.env.AUTH_SERVICE_URL,
    });
  } catch (error) {
    if (!(error instanceof KernelWebhookError) || ['STORE', 'DISCOVERY', 'TRUST'].includes(error.code)) {
      return Response.json({ error: 'Webhook verification unavailable' }, { status: 503 });
    }
    if (error.code === 'INVALID_BODY') {
      return Response.json({ error: 'Invalid webhook body' }, { status: 400 });
    }
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await handleKernelNotification(payload);
    return Response.json({ received: true });
  } catch {
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}
