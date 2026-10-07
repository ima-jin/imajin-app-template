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

function SignInLink() {
  const authUrl = process.env.NEXT_PUBLIC_IMAJIN_AUTH_URL ?? '';
  const appId = process.env.NEXT_PUBLIC_IMAJIN_APP_ID ?? '';
  const signInUrl = `${authUrl}/auth/authorize?app_id=${appId}&scopes=profile:read`;

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
