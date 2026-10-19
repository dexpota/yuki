import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InstallationSettingsPage } from '../../src/settings/installation/index.js';

afterEach(() => {
  cleanup();
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
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/system/information')) return Response.json(systemInformationFixture());
      if (url.includes('/notifications/webhook-configuration')) {
        return Response.json(
          init?.method === 'PATCH'
            ? { ...webhookFixture(), enabled: true, configured: true, version: 2 }
            : webhookFixture(),
        );
      }
      if (url.includes('/notifications/deliveries')) return Response.json({ deliveries: [] });
      return Response.json(init?.method === 'PATCH' ? { ...settings, version: 4 } : settings);
    });
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
    expect(await screen.findByText('This installation is up to date.')).toBeInTheDocument();
    expect(screen.getByText('0.2.1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Update instructions' })).toHaveAttribute(
      'href',
      'https://github.com/dexpota/yuki/blob/0.2.1/deploy/PRODUCTION.md#apply-a-release-update',
    );
    expect(
      await screen.findByRole('heading', { name: 'External notifications' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Webhook URL/)).toHaveAttribute(
      'placeholder',
      'https://hooks.example.test',
    );
    expect(screen.getByRole('link', { name: 'Manage printers' })).toHaveAttribute(
      'href',
      '/printers',
    );
    fireEvent.change(screen.getByLabelText('Archive members'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([input, init]) =>
            String(input).includes('/settings/installation') && init?.method === 'PATCH',
        ),
      ).toBe(true),
    );
    const request = fetch.mock.calls.find(
      ([input, init]) =>
        String(input).includes('/settings/installation') && init?.method === 'PATCH',
    )?.[1];
    expect(request?.headers).toBeInstanceOf(Headers);
    if (!(request?.headers instanceof Headers)) throw new Error('Expected request headers');
    expect(request.headers.get('x-csrf-token')).toBe('csrf');
    expect(JSON.parse(String(request?.body))).toMatchObject({
      expectedVersion: 3,
      limits: { archiveMaxMembers: 250 },
    });
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Enable webhook delivery'));
    fireEvent.change(screen.getByLabelText('Bearer token (optional)'), {
      target: { value: 'rotated-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save webhook' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([input, init]) =>
            String(input).includes('/notifications/webhook-configuration') &&
            init?.method === 'PATCH',
        ),
      ).toBe(true),
    );
    const webhookRequest = fetch.mock.calls.find(
      ([input, init]) =>
        String(input).includes('/notifications/webhook-configuration') && init?.method === 'PATCH',
    )?.[1];
    expect(JSON.parse(String(webhookRequest?.body))).toEqual({
      enabled: true,
      bearerToken: 'rotated-token',
      expectedVersion: 1,
    });
    expect(await screen.findByText('Webhook settings saved.')).toBeInTheDocument();
  });

  it('shows update availability and remains useful when release checks are unavailable', async () => {
    const settings = fixture();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/system/information'))
        return Response.json({
          version: '0.2.0',
          revision: 'a'.repeat(40),
          release: {
            status: 'update-available',
            latestVersion: '0.2.1',
            releaseNotesUrl: 'https://github.com/dexpota/yuki/releases/tag/0.2.1',
            updateGuideUrl:
              'https://github.com/dexpota/yuki/blob/0.2.1/deploy/PRODUCTION.md#apply-a-release-update',
          },
        });
      if (url.includes('/notifications/webhook-configuration'))
        return Response.json(webhookFixture());
      if (url.includes('/notifications/deliveries')) return Response.json({ deliveries: [] });
      return Response.json(settings);
    });
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = () =>
      render(
        <QueryClientProvider client={client}>
          <InstallationSettingsPage csrfToken="csrf" />
        </QueryClientProvider>,
      );

    view();
    expect(await screen.findByText('Yuki 0.2.1 is available.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute(
      'href',
      'https://github.com/dexpota/yuki/releases/tag/0.2.1',
    );

    cleanup();
    client.clear();
    fetch.mockImplementation(async (input: string | URL | Request) => {
      if (String(input).includes('/system/information'))
        return Response.json({
          version: '0.2.1',
          revision: 'a'.repeat(40),
          release: {
            status: 'check-unavailable',
            latestVersion: null,
            releaseNotesUrl: null,
            updateGuideUrl: null,
          },
        });
      if (String(input).includes('/notifications/webhook-configuration'))
        return Response.json(webhookFixture());
      if (String(input).includes('/notifications/deliveries'))
        return Response.json({ deliveries: [] });
      return Response.json(settings);
    });
    view();
    expect(await screen.findByText(/Yuki remains operational/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Production update instructions' })).toHaveAttribute(
      'href',
      'https://github.com/dexpota/yuki/blob/develop/deploy/PRODUCTION.md#apply-a-release-update',
    );

    cleanup();
    client.clear();
    fetch.mockImplementation(async (input: string | URL | Request) => {
      if (String(input).includes('/system/information'))
        return Response.json({
          version: '0.0.0-development',
          revision: 'unknown',
          release: {
            status: 'unsupported',
            latestVersion: null,
            releaseNotesUrl: null,
            updateGuideUrl: null,
          },
        });
      if (String(input).includes('/notifications/webhook-configuration'))
        return Response.json(webhookFixture());
      if (String(input).includes('/notifications/deliveries'))
        return Response.json({ deliveries: [] });
      return Response.json(settings);
    });
    view();
    expect(await screen.findByText(/not a supported release/)).toBeInTheDocument();
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
      mode: 'webhook',
      configurable: true,
      apiPath: '/api/v1/notifications/webhook-configuration',
      message: 'Generic HTTPS webhook delivery is available.',
    },
    configurationSurfaces: {
      printers: { apiPath: '/api/v1/printing/printers' },
      storage: { managedByInstallation: true, exposesSecrets: false },
    },
    version: 3,
    updatedAt: null,
  } as const;
}

function webhookFixture() {
  return {
    mode: 'webhook',
    enabled: false,
    configured: true,
    endpointDisplay: 'https://hooks.example.test',
    bearerTokenConfigured: true,
    version: 1,
    updatedAt: '2026-07-29T09:00:00.000Z',
  } as const;
}

function systemInformationFixture() {
  return {
    version: '0.2.1',
    revision: 'f'.repeat(40),
    release: {
      status: 'current',
      latestVersion: '0.2.1',
      releaseNotesUrl: 'https://github.com/dexpota/yuki/releases/tag/0.2.1',
      updateGuideUrl:
        'https://github.com/dexpota/yuki/blob/0.2.1/deploy/PRODUCTION.md#apply-a-release-update',
    },
  } as const;
}
