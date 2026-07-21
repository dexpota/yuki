import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionExpiredEvent } from '../../src/shared/api/http.js';
import { AppProviders, createTestRouter } from '../../src/shared/app/App.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderRoute(path = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createTestRouter([path]);
  const rendered = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...rendered, queryClient, router };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return Response.json(body, init);
}

const anonymousSession = {
  authenticated: false,
  setupRequired: false,
  csrfToken: 'csrf-pre-auth',
};

const authenticatedSession = {
  authenticated: true,
  setupRequired: false,
  owner: { id: 'owner-1', username: 'Fabrizio' },
  csrfToken: 'csrf-session',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

describe('identity session flows', () => {
  it('redirects a clean installation to setup and establishes the first session', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ...anonymousSession, setupRequired: true, csrfToken: 'setup-csrf' }),
      )
      .mockResolvedValueOnce(jsonResponse(authenticatedSession));
    vi.stubGlobal('fetch', fetchMock);
    const { router } = renderRoute('/');

    expect(
      await screen.findByRole('heading', { name: 'Create your owner account' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/setup');

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'Fabrizio' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'a secure password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      await screen.findByRole('heading', { name: /keep every model ready/i }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/session/setup',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ username: 'Fabrizio', password: 'a secure password' }),
      }),
    );
    const headers = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.headers;
    expect(headers).toBeInstanceOf(Headers);
    if (!(headers instanceof Headers)) throw new Error('Expected request headers');
    expect(headers.get('x-csrf-token')).toBe('setup-csrf');
  });

  it('restores an authenticated session without browser token storage and signs out', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(authenticatedSession))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(anonymousSession));
    vi.stubGlobal('fetch', fetchMock);
    renderRoute('/');

    expect(await screen.findByText('Fabrizio')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(
      await screen.findByRole('heading', { name: 'Sign in to your catalogue' }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/session',
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    );
    const headers = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.headers;
    expect(headers).toBeInstanceOf(Headers);
    if (!(headers instanceof Headers)) throw new Error('Expected request headers');
    expect(headers.get('x-csrf-token')).toBe('csrf-session');
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it('shows a useful credential error and retains the sign-in form', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(anonymousSession))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'authentication_required',
              message: 'Authentication is required',
              requestId: 'request-1',
            },
          },
          { status: 401 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    renderRoute('/sign-in');

    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'Owner' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'incorrect' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The username or password is incorrect.',
    );
    expect(screen.getByLabelText('Username')).toHaveValue('Owner');
  });

  it('recovers from an API-reported expired session by returning to sign-in', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(authenticatedSession))
      .mockResolvedValueOnce(jsonResponse(anonymousSession));
    vi.stubGlobal('fetch', fetchMock);
    const { router } = renderRoute('/');

    expect(await screen.findByText('Fabrizio')).toBeInTheDocument();
    window.dispatchEvent(new Event(sessionExpiredEvent));

    expect(
      await screen.findByText('Your session expired. Sign in again to continue.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
  });

  it('offers a retry when session restoration cannot reach the server', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(jsonResponse(anonymousSession));
    vi.stubGlobal('fetch', fetchMock);
    renderRoute('/');

    expect(await screen.findByRole('alert')).toHaveTextContent('could not check your session');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Sign in to your catalogue' }),
    ).toBeInTheDocument();
  });
});
