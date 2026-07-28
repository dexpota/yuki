import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProviders, createTestRouter } from '../../src/shared/app/App.js';

const unread = {
  id: 'notification-1',
  kind: 'print_failed',
  printAttemptId: 'attempt-1',
  printerId: 'printer-1',
  title: 'Print failed',
  message: 'Workshop: cube.gcode',
  facts: { schemaVersion: 1 },
  readAt: null,
  createdAt: '2026-07-28T10:00:00.000Z',
  updatedAt: '2026-07-28T10:00:00.000Z',
  version: 1,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith('/api/v1/notifications?'))
        return Promise.resolve(Response.json({ notifications: [unread], unreadCount: 1 }));
      if (path.endsWith('/read-state') && init?.method === 'PUT')
        return Promise.resolve(
          Response.json({
            ...unread,
            readAt: '2026-07-28T10:01:00.000Z',
            updatedAt: '2026-07-28T10:01:00.000Z',
            version: 2,
          }),
        );
      if (path === '/api/v1/notifications/read-all')
        return Promise.resolve(Response.json({ updated: 1 }));
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

describe('in-application notifications', () => {
  it('shows a live unread badge and notification list', async () => {
    renderRoute('/notifications');

    expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeInTheDocument();
    expect(await screen.findByText('Workshop: cube.gcode')).toBeInTheDocument();
    expect(screen.getByText('1 unread notifications')).toBeInTheDocument();
    expect(screen.getByText('1 unread notification.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open printer' })).toHaveAttribute(
      'href',
      '/printers/printer-1',
    );
  });

  it('marks an individual notification read with CSRF and optimistic version', async () => {
    renderRoute('/notifications');
    await screen.findByText('Workshop: cube.gcode');

    fireEvent.click(screen.getByRole('button', { name: 'Mark as read' }));
    await waitFor(() => {
      const request = vi
        .mocked(fetch)
        .mock.calls.find(([path]) => String(path).endsWith('/read-state'));
      expect(request?.[1]).toMatchObject({
        method: 'PUT',
        body: JSON.stringify({ read: true, expectedVersion: 1 }),
      });
      expect(new Headers(request?.[1]?.headers).get('x-csrf-token')).toBe('csrf-session');
    });
  });

  it('requests the unread-only view and supports marking all read', async () => {
    renderRoute('/notifications');
    await screen.findByText('Workshop: cube.gcode');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Unread only' }));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        '/api/v1/notifications?limit=100&unread=true',
        expect.anything(),
      ),
    );
    const markAll = screen.getByRole('button', { name: 'Mark all read' });
    await waitFor(() => expect(markAll).toBeEnabled());
    fireEvent.click(markAll);
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        '/api/v1/notifications/read-all',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});
