import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';

import { ApiError } from '../../shared/api/http.js';
import { type Credentials, type SessionState, sessionQueryKey, setupOwner, signIn } from './api.js';

type AnonymousSession = Extract<SessionState, { authenticated: false }>;

export function SetupPage({ session }: { readonly session: AnonymousSession }) {
  return (
    <IdentityForm
      eyebrow="Welcome to Yuki"
      heading="Create your owner account"
      introduction="This account protects your catalogue and printer controls."
      submitLabel="Create account"
      pendingLabel="Creating account…"
      session={session}
      mutation={setupOwner}
      passwordHelp="Use at least 12 characters."
    />
  );
}

export function SignInPage({
  session,
  expired,
}: {
  readonly session: AnonymousSession;
  readonly expired: boolean;
}) {
  return (
    <IdentityForm
      eyebrow="Yuki"
      heading="Sign in to your catalogue"
      introduction="Enter the owner account credentials for this installation."
      submitLabel="Sign in"
      pendingLabel="Signing in…"
      session={session}
      mutation={signIn}
      {...(expired ? { notice: 'Your session expired. Sign in again to continue.' } : {})}
    />
  );
}

interface IdentityFormProps {
  readonly eyebrow: string;
  readonly heading: string;
  readonly introduction: string;
  readonly submitLabel: string;
  readonly pendingLabel: string;
  readonly session: AnonymousSession;
  readonly mutation: (credentials: Credentials, csrfToken: string) => Promise<SessionState>;
  readonly passwordHelp?: string;
  readonly notice?: string;
}

function IdentityForm(props: IdentityFormProps) {
  const queryClient = useQueryClient();
  const usernameId = useId();
  const passwordId = useId();
  const errorId = useId();
  const [credentials, setCredentials] = useState<Credentials>({ username: '', password: '' });
  const mutation = useMutation({
    mutationFn: () => props.mutation(credentials, props.session.csrfToken),
    onSuccess: (nextSession) => queryClient.setQueryData(sessionQueryKey, nextSession),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <main className="identity-page">
      <section className="identity-card" aria-labelledby="identity-heading">
        <p className="eyebrow">{props.eyebrow}</p>
        <h1 id="identity-heading">{props.heading}</h1>
        <p>{props.introduction}</p>
        {props.notice === undefined ? null : (
          <p className="identity-notice" role="status">
            {props.notice}
          </p>
        )}
        <form onSubmit={submit}>
          <div className="form-field">
            <label htmlFor={usernameId}>Username</label>
            <input
              id={usernameId}
              name="username"
              autoComplete="username"
              required
              maxLength={100}
              value={credentials.username}
              onChange={(event) =>
                setCredentials((current) => ({ ...current, username: event.target.value }))
              }
            />
          </div>
          <div className="form-field">
            <label htmlFor={passwordId}>Password</label>
            <input
              id={passwordId}
              name="password"
              type="password"
              autoComplete={props.session.setupRequired ? 'new-password' : 'current-password'}
              required
              minLength={props.session.setupRequired ? 12 : undefined}
              maxLength={1024}
              aria-describedby={mutation.error === null ? undefined : errorId}
              value={credentials.password}
              onChange={(event) =>
                setCredentials((current) => ({ ...current, password: event.target.value }))
              }
            />
            {props.passwordHelp === undefined ? null : (
              <span className="field-help">{props.passwordHelp}</span>
            )}
          </div>
          {mutation.error === null ? null : (
            <p className="form-error" id={errorId} role="alert">
              {messageFor(mutation.error)}
            </p>
          )}
          <button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? props.pendingLabel : props.submitLabel}
          </button>
        </form>
      </section>
    </main>
  );
}

function messageFor(error: Error): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'The username or password is incorrect.';
    if (error.code === 'setup_already_completed') {
      return 'Setup was already completed. Refresh to sign in.';
    }
    if (error.code === 'credentials_invalid') {
      return 'Check the username and password requirements and try again.';
    }
  }
  return 'Yuki could not complete the request. Try again.';
}
