import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, createTestRouter } from '../src/shared/app/App.js';
import { AppErrorBoundary } from '../src/shared/app/AppErrorBoundary.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith('/api/v1/catalogue/models?'))
        return Promise.resolve(Response.json({ items: [], nextCursor: null }));
      if (path === '/api/v1/catalogue/tags' || path === '/api/v1/catalogue/collections')
        return Promise.resolve(Response.json([]));
      return Promise.resolve(
        Response.json({
          authenticated: true,
          setupRequired: false,
          owner: { id: 'owner-1', username: 'Owner' },
          csrfToken: 'csrf-session',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      );
    }),
  );
});

function renderRoute(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={createTestRouter([path])} />
    </AppProviders>,
  );
}

describe('application shell', () => {
  it('renders the routed home page', async () => {
    renderRoute('/');

    expect(await screen.findByRole('heading', { name: 'Your models' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Yuki home' })).toHaveAttribute('href', '/');
  });

  it('renders a useful not-found route', async () => {
    renderRoute('/does-not-exist');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Return home' })).toHaveAttribute('href', '/');
  });

  it('composes the authenticated manual import route', async () => {
    renderRoute('/import');

    expect(await screen.findByRole('heading', { name: 'Add a model' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute('href', '/import');
  });
});

describe('application error boundary', () => {
  it('renders a recoverable error screen for an uncaught render error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    function BrokenComponent(): ReactNode {
      throw new Error('test failure');
    }

    render(
      <AppErrorBoundary>
        <BrokenComponent />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Yuki could not continue');
    expect(screen.getByRole('button', { name: 'Reload Yuki' })).toBeInTheDocument();
  });
});
