import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, createTestRouter } from '../src/shared/app/App.js';
import { AppErrorBoundary } from '../src/shared/app/AppErrorBoundary.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

    expect(await screen.findByRole('heading', { name: /keep every model/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Yuki home' })).toHaveAttribute('href', '/');
  });

  it('renders a useful not-found route', async () => {
    renderRoute('/does-not-exist');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Return home' })).toHaveAttribute('href', '/');
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
