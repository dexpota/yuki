import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InstallationSettingsPage } from '../../src/settings/installation/index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('installation settings page', () => {
  it('shows a load failure instead of remaining in a loading state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <InstallationSettingsPage csrfToken="csrf" />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings could not be loaded.');
  });

  it('renders capability surfaces and saves validated settings with concurrency version', async () => {
    const settings = fixture();
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      Response.json(init?.method === 'PATCH' ? { ...settings, version: 4 } : settings),
    );
    vi.stubGlobal('fetch', fetch);
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <InstallationSettingsPage csrfToken="csrf" />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText(/Notification channels are not available/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage printers' })).toHaveAttribute(
      'href',
      '/printers',
    );
    fireEvent.change(screen.getByLabelText('Archive members'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const request = fetch.mock.calls[1]?.[1];
    expect(request?.headers).toBeInstanceOf(Headers);
    if (!(request?.headers instanceof Headers)) throw new Error('Expected request headers');
    expect(request.headers.get('x-csrf-token')).toBe('csrf');
    expect(JSON.parse(String(request?.body))).toMatchObject({
      expectedVersion: 3,
      limits: { archiveMaxMembers: 250 },
    });
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
  });
});
function fixture() {
  return {
    limits: {
      uploadMaxBytes: 2147483648,
      archiveMaxMembers: 1000,
      archiveExpandedMaxBytes: 10737418240,
      archiveMaxRatio: 200,
    },
    retention: { trashDays: 30, jobDays: 90, observationHistoryEntries: 120 },
    authentication: { mode: 'password' },
    notifications: {
      mode: 'disabled',
      configurable: false,
      message: 'Notification channels are not available in this release.',
    },
    configurationSurfaces: {
      printers: { apiPath: '/api/v1/printing/printers' },
      storage: { managedByInstallation: true, exposesSecrets: false },
    },
    version: 3,
    updatedAt: null,
  } as const;
}
