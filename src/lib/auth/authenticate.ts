import { requireSessionOrAppToken } from '@ima-jin/auth';
import { APP_SLUG } from '@/lib/app-slug';

/**
 * This app's inbound-auth surface for routes that accept a scoped app token
 * (`Authorization: Bearer`, e.g. an agent / MCP client) OR the shared kernel
 * session cookie. Routes call `authenticate(request)` and never an auth
 * primitive directly.
 *
 * The expected token audience is this app's registry slug (`APP_SLUG`),
 * never the shared host (imajin-ai#2706); `IMAJIN_APP_AUD` overrides it
 * inside `@ima-jin/auth`. A Bearer that fails verification is a 401 — it
 * never falls back to the cookie.
 */
export interface AuthenticatedCaller {
  /** DID of the authenticated caller. */
  did: string;
  /** Capability scopes granted to this call (empty on the cookie path). */
  scopes: string[];
  /** Which path authenticated this request — surfaced for logging/debugging only. */
  via: 'token' | 'cookie';
}

export type AuthenticateSuccess = { auth: AuthenticatedCaller };
export type AuthenticateFailure = { error: string; status: number };
export type AuthenticateResult = AuthenticateSuccess | AuthenticateFailure;

export interface AuthenticateOptions {
  requireScopes?: string[];
}

export async function authenticate(request: Request, options?: AuthenticateOptions): Promise<AuthenticateResult> {
  const result = await requireSessionOrAppToken(request, {
    slug: APP_SLUG,
    requireScopes: options?.requireScopes,
  });
  if ('error' in result) {
    return { error: result.error, status: result.status };
  }
  return { auth: result.auth };
}
