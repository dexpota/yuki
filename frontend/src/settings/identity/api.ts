import { apiRequest } from '../../shared/api/http.js';

export interface IdentityOwner {
  readonly id: string;
  readonly username: string;
}

export type SessionState =
  | {
      readonly authenticated: true;
      readonly setupRequired: false;
      readonly owner: IdentityOwner;
      readonly csrfToken: string;
      readonly expiresAt: string;
    }
  | {
      readonly authenticated: false;
      readonly setupRequired: boolean;
      readonly csrfToken: string;
    };

export const sessionQueryKey = ['identity', 'session'] as const;

export function getSession(): Promise<SessionState> {
  return apiRequest<SessionState>('/api/v1/session', { reportUnauthorized: false });
}

export function setupOwner(credentials: Credentials, csrfToken: string): Promise<SessionState> {
  return apiRequest<SessionState>('/api/v1/session/setup', {
    method: 'POST',
    body: JSON.stringify(credentials),
    csrfToken,
    reportUnauthorized: false,
  });
}

export function signIn(credentials: Credentials, csrfToken: string): Promise<SessionState> {
  return apiRequest<SessionState>('/api/v1/session', {
    method: 'POST',
    body: JSON.stringify(credentials),
    csrfToken,
    reportUnauthorized: false,
  });
}

export function signOut(csrfToken: string): Promise<void> {
  return apiRequest<void>('/api/v1/session', { method: 'DELETE', csrfToken });
}

export interface Credentials {
  readonly username: string;
  readonly password: string;
}
