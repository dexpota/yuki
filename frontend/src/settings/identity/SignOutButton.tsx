import { useMutation, useQueryClient } from '@tanstack/react-query';

import { type SessionState, sessionQueryKey, signOut } from './api.js';

export function SignOutButton({ session }: { readonly session: SessionState }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => signOut(session.csrfToken),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: sessionQueryKey }),
  });

  return (
    <div className="session-actions">
      <button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? 'Signing out…' : 'Sign out'}
      </button>
      {mutation.isError ? (
        <span className="sign-out-error" role="alert">
          Could not sign out. Try again.
        </span>
      ) : null}
    </div>
  );
}
