import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelPrintHistory, PrintHistoryPage } from '../../src/printing/history/index.js';
import { sessionQueryKey } from '../../src/settings/identity/api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('print history UI', () => {
  it('records a manual attempt against an exact model version and G-code asset', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/printing/printers'))
        return Response.json([
          {
            id: 'printer-1',
            displayName: 'Workshop MK4',
            enabled: true,
            connectionStatus: 'online',
          },
        ]);
      if (url.includes('/printing/print-attempts') && init?.method === 'POST')
        return Response.json(attempt(), { status: 201 });
      if (url.includes('/printing/print-attempts')) return Response.json({ attempts: [] });
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetch);
    renderHistory(
      <ModelPrintHistory
        csrfToken="csrf-session"
        context={{
          modelId: 'model-1',
          currentVersionId: 'version-2',
          printCount: 0,
          lastPrintedAt: null,
          versions: [
            { id: 'version-2', label: 'v2' },
            { id: 'version-1', label: 'v1' },
          ],
          assets: [
            {
              id: 'asset-gcode-2',
              modelVersionId: 'version-2',
              filename: 'benchy-v2.gcode',
              format: 'gcode',
            },
          ],
        }}
      />,
    );

    expect(await screen.findByText('No print attempts match this view yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Record manual attempt' }));
    fireEvent.change(await screen.findByLabelText('Printer'), {
      target: { value: 'printer-1' },
    });
    fireEvent.change(screen.getByLabelText('Notes'), {
      target: { value: 'Clean first layer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save attempt' }));

    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url, init]) => {
          if (!String(url).endsWith('/printing/print-attempts') || init?.method !== 'POST')
            return false;
          const body = JSON.parse(String(init.body));
          return (
            body.modelId === 'model-1' &&
            body.modelVersionId === 'version-2' &&
            body.assetId === 'asset-gcode-2' &&
            body.printerId === 'printer-1' &&
            body.notes === 'Clean first layer' &&
            new Headers(init.headers).get('x-csrf-token') === 'csrf-session'
          );
        }),
      ).toBe(true),
    );
  });

  it('filters printer history and saves corrections, notes, and a result photo', async () => {
    const current = attempt();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/printing/printers'))
        return Response.json([
          {
            id: 'printer-1',
            displayName: 'Workshop MK4',
            enabled: true,
            connectionStatus: 'online',
          },
        ]);
      if (url.includes('/photos') && init?.method === 'POST')
        return Response.json(
          {
            id: 'photo-2',
            filename: 'result.webp',
            mimeType: 'image/webp',
            byteSize: 3,
            checksum: 'b'.repeat(64),
            createdAt: '2026-07-28T10:00:00.000Z',
            downloadUrl: '/photo-2',
          },
          { status: 201 },
        );
      if (init?.method === 'PUT' || init?.method === 'POST') return Response.json(current);
      if (url.includes('/printing/print-attempts')) return Response.json({ attempts: [current] });
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetch);
    renderHistory(<PrintHistoryPage />, authenticatedClient());

    expect(await screen.findByRole('link', { name: 'Benchy' })).toHaveAttribute(
      'href',
      '/catalogue/models/model-1',
    );
    fireEvent.change(screen.getByLabelText('Printer'), { target: { value: 'printer-1' } });
    await waitFor(() =>
      expect(fetch.mock.calls.some(([url]) => String(url).includes('printerId=printer-1'))).toBe(
        true,
      ),
    );
    expect(await screen.findByRole('link', { name: 'Benchy' })).toHaveAttribute(
      'href',
      '/catalogue/models/model-1',
    );
    fireEvent.click(screen.getByText('Edit result'));

    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Updated note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
    fireEvent.change(screen.getByLabelText('Correct outcome'), { target: { value: 'failed' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Part detached' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record correction' }));
    const file = new File(['img'], 'result.webp', { type: 'image/webp' });
    fireEvent.change(screen.getByLabelText('Add result photo'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload photo' }));

    await waitFor(() => {
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/attempt-1/notes') &&
            init?.method === 'PUT' &&
            init.body === JSON.stringify({ notes: 'Updated note' }),
        ),
      ).toBe(true);
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/attempt-1/outcome-corrections') &&
            init?.method === 'POST' &&
            String(init.body).includes('Part detached'),
        ),
      ).toBe(true);
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/attempt-1/photos') &&
            init?.method === 'POST' &&
            init.body === file &&
            new Headers(init.headers).get('content-type') === 'image/webp',
        ),
      ).toBe(true);
    });
  });
});

function renderHistory(node: React.ReactNode, queryClient = client()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function authenticatedClient() {
  const queryClient = client();
  queryClient.setQueryData(sessionQueryKey, {
    authenticated: true,
    setupRequired: false,
    owner: { id: 'owner-1', username: 'Owner' },
    csrfToken: 'csrf-session',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  return queryClient;
}

function attempt() {
  return {
    id: 'attempt-1',
    source: 'manual',
    queueEntryId: null,
    printerId: 'printer-1',
    modelId: 'model-1',
    modelVersionId: 'version-2',
    assetId: 'asset-gcode-2',
    state: 'completed',
    outcome: 'successful',
    notes: 'Clean first layer',
    statistics: {},
    printerSnapshot: { name: 'Workshop MK4' },
    modelSnapshot: { name: 'Benchy', versionLabel: 'v2' },
    assetSnapshot: { filename: 'benchy-v2.gcode' },
    compatibilitySnapshot: {},
    overrideJustification: null,
    startedAt: '2026-07-28T08:00:00.000Z',
    completedAt: '2026-07-28T09:00:00.000Z',
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    version: 1,
    photos: [
      {
        id: 'photo-1',
        filename: 'finished.webp',
        mimeType: 'image/webp',
        byteSize: 3,
        checksum: 'a'.repeat(64),
        createdAt: '2026-07-28T09:01:00.000Z',
        downloadUrl: '/photo-1',
      },
    ],
  };
}
