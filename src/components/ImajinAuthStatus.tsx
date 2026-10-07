'use client';

import { useEffect, useState } from 'react';
import type { SessionUser } from '@ima-jin/auth-client';

type SessionState = { status: 'loading' } | { status: 'ready'; user: SessionUser | null };

export function ImajinAuthStatus() {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    fetch('/api/auth/session')
      .then((response) => response.json())
      .then((user: SessionUser | null) => {
        if (!cancelled) {
          setSession({ status: 'ready', user });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSession({ status: 'ready', user: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (session.status === 'loading') {
    return <div className="h-9 w-28 animate-pulse rounded-lg bg-field" />;
  }

  if (!session.user) {
    return <SignInLink />;
  }

  return <SignedInStatus user={session.user} />;
}

/**
 * The kernel's authorize URL, or `null` when `authUrl` or `appId` is empty — an
 * empty `authUrl` would otherwise produce a relative `/auth/authorize?...` link
 * that 404s on this app. (Boot-time env guards in instrumentation.ts make that
 * unreachable in a configured deployment; this keeps the component safe on its own.)
 */
export function buildSignInUrl(authUrl: string, appId: string): string | null {
  let base = authUrl.trim();
  while (base.endsWith('/')) {
    base = base.slice(0, -1);
  }
  const id = appId.trim();
  if (base === '' || id === '') {
    return null;
  }
  return `${base}/auth/authorize?app_id=${encodeURIComponent(id)}&scopes=profile:read`;
}

function SignInLink() {
  // Literal `process.env.NEXT_PUBLIC_*` reads so Next.js can inline them at build time.
  const signInUrl = buildSignInUrl(
    process.env.NEXT_PUBLIC_IMAJIN_AUTH_URL ?? '',
    process.env.NEXT_PUBLIC_IMAJIN_APP_ID ?? ''
  );

  if (signInUrl === null) {
    return null;
  }

  return (
    <a
      href={signInUrl}
      className="inline-flex items-center gap-2 rounded-lg border border-field-border bg-field px-4 py-2 text-sm font-medium text-foreground transition-colors hover:underline"
    >
      Sign in with <strong className="text-link">Imajin</strong>
    </a>
  );
}

function SignedInStatus({ user }: Readonly<{ user: SessionUser }>) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-foreground">{user.displayName}</span>
      <form action="/api/auth/logout" method="POST">
        <button
          type="submit"
          className="text-xs text-muted underline-offset-2 hover:underline"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
