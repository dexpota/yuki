import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';

import { sessionExpiredEvent } from '../../shared/api/http.js';
import { getSession, sessionQueryKey } from './api.js';
import { SetupPage, SignInPage } from './views.js';

const authenticationPaths = new Set(['/setup', '/sign-in']);

export function useSession() {
  return useQuery({
    queryKey: sessionQueryKey,
    queryFn: getSession,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function SessionGate() {
  const queryClient = useQueryClient();
  const session = useSession();
  const location = useLocation();
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const expire = () => {
      setExpired(true);
      void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    };
    window.addEventListener(sessionExpiredEvent, expire);
    return () => window.removeEventListener(sessionExpiredEvent, expire);
  }, [queryClient]);

  useEffect(() => {
    if (session.data?.authenticated !== true) return;
    const delay = Date.parse(session.data.expiresAt) - Date.now();
    if (delay <= 0) {
      setExpired(true);
      void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      return;
    }
    const timer = window.setTimeout(
      () => {
        setExpired(true);
        void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      },
      Math.min(delay, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [queryClient, session.data]);

  if (session.isPending) return <SessionLoading />;
  if (session.isError) return <SessionLoadError retry={() => void session.refetch()} />;

  const state = session.data;
  if (state.authenticated) {
    if (authenticationPaths.has(location.pathname)) return <Navigate replace to="/" />;
    return <Outlet />;
  }

  const destination = state.setupRequired ? '/setup' : '/sign-in';
  if (location.pathname !== destination) return <Navigate replace to={destination} />;
  if (state.setupRequired) return <SetupPage session={state} />;
  return <SignInPage expired={expired} session={state} />;
}

function SessionLoading() {
  return (
    <main className="identity-status" aria-busy="true" aria-live="polite">
      <p className="eyebrow">Yuki</p>
      <h1>Opening your catalogue…</h1>
    </main>
  );
}

function SessionLoadError({ retry }: { readonly retry: () => void }) {
  return (
    <main className="identity-status" role="alert">
      <p className="eyebrow">Connection problem</p>
      <h1>Yuki could not check your session.</h1>
      <p>Check that the server is running, then try again.</p>
      <button type="button" onClick={retry}>
        Try again
      </button>
    </main>
  );
}
