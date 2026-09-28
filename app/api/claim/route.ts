import { NextResponse, type NextRequest } from 'next/server';
import { claimWithCode, isAppClaimed } from '@/lib/signing-identity';
import { isRateLimited, recordAttempt } from '@/lib/claim-rate-limit';

/**
 * POST /api/claim — the operator `/claim` page's server-side counterpart
 * (#2427). Takes the claim code an operator pasted from the kernel's `/jin`
 * approval card, redeems it against the kernel's own
 * `POST /api/apps/claim` (via `@ima-jin/auth-client`'s `loadAppSigningKey()`,
 * see `src/lib/signing-identity.ts`'s `claimWithCode()`), and hot-swaps this
 * app's in-memory signing identity — no restart required.
 *
 * The raw signing private key never leaves this server process: only the
 * app DID and public key are returned to the browser. The claim code itself
 * is never logged, on success or failure.
 */
export const dynamic = 'force-dynamic';

const MAX_CLAIM_CODE_LENGTH = 200;

interface ClaimRequestBody {
  claimCode?: unknown;
}

function clientKeyFor(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const firstHop = forwardedFor?.split(',')[0]?.trim();
  if (firstHop) {
    return firstHop;
  }
  return 'unknown';
}

function validateClaimBody(body: ClaimRequestBody): { ok: true; claimCode: string } | { ok: false; error: string } {
  if (typeof body.claimCode !== 'string' || body.claimCode.length === 0) {
    return { ok: false, error: 'Claim code is required' };
  }
  if (body.claimCode.length > MAX_CLAIM_CODE_LENGTH) {
    return { ok: false, error: 'Claim code is too long' };
  }
  return { ok: true, claimCode: body.claimCode };
}

export async function POST(request: NextRequest) {
  if (isAppClaimed()) {
    return NextResponse.json({ error: 'This app has already been claimed' }, { status: 404 });
  }

  const clientKey = clientKeyFor(request);
  if (isRateLimited(clientKey)) {
    return NextResponse.json({ error: 'Too many claim attempts — please try again later' }, { status: 429 });
  }

  let body: ClaimRequestBody;
  try {
    body = (await request.json()) as ClaimRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const validation = validateClaimBody(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  recordAttempt(clientKey);

  try {
    const identity = await claimWithCode({ claimCode: validation.claimCode });
    return NextResponse.json({ appDid: identity.appDid, publicKey: identity.publicKey });
  } catch (error) {
    // Deliberately logs only a fixed message — never the claim code, and
    // never the raw kernel error body (which could echo request input).
    console.error(
      'POST /api/claim: claim exchange failed',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json({ error: 'Unable to redeem this claim code' }, { status: 400 });
  }
}
