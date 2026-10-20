import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrintPlanPage } from '../../src/printing/plan/index.js';
import { sessionQueryKey } from '../../src/settings/identity/api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('printer-independent print plan', () => {
  it('sends a selected version G-code file to a printer and keeps the planning entry', async () => {
    const entry = {
      id: 'plan-1',
      modelId: 'model-1',
      modelName: 'Benchy',
      versionId: 'version-2',
      versionLabel: 'v2',
      assets: [{ id: 'asset-v2', filename: 'benchy-v2.gcode' }],
      position: 0,
      unavailable: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/printing/plan')) {
        if (init?.method === 'POST') return Response.json(entry, { status: 201 });
        return Response.json({ entries: [entry] });
      }
      if (url.endsWith('/printing/printers'))
        return Response.json([
          {
            id: 'printer-1',
            displayName: 'Workshop MK4',
            enabled: true,
            credentialConfigured: true,
            connectionStatus: 'online',
            operationalState: 'operational',
            profile: {},
            verifiedAt: '2026-01-01T00:00:00.000Z',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            version: 1,
          },
        ]);
      if (url.endsWith('/printers/printer-1/queue') && init?.method === 'POST')
        return Response.json({ id: 'queue-1' }, { status: 201 });
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetch);
    renderPlan(authenticatedClient());

    expect(await screen.findByRole('heading', { name: 'Benchy' })).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText('G-code file'), {
      target: { value: 'asset-v2' },
    });
    fireEvent.change(screen.getByLabelText('Printer'), { target: { value: 'printer-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to printer queue' }));

    expect(
      await screen.findByText('Added to the printer queue. This item remains in your print plan.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url, init]) => {
          if (!String(url).endsWith('/printers/printer-1/queue') || init?.method !== 'POST')
            return false;
          return (
            JSON.parse(String(init.body)).assetId === 'asset-v2' &&
            new Headers(init.headers).get('x-csrf-token') === 'csrf-session'
          );
        }),
      ).toBe(true),
    );
    expect(screen.getByRole('heading', { name: 'Benchy' })).toBeInTheDocument();
    expect(screen.getByText('Version v2')).toBeInTheDocument();
  });

  it('reorders, removes, and labels unavailable entries', async () => {
    let current = [planEntry('plan-1', 'Benchy', 0, false), planEntry('plan-2', 'Vase', 1, true)];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/printing/plan/order')) {
        const ids = JSON.parse(String(init?.body)).entryIds as string[];
        current = ids.map((id, position) => {
          const entry = current.find((candidate) => candidate.id === id);
          if (!entry) throw new Error(`Unexpected plan entry ${id}.`);
          return { ...entry, position };
        });
        return Response.json({ entries: current });
      }
      if (url.endsWith('/printing/plan/plan-2') && init?.method === 'DELETE') {
        current = current.filter((entry) => entry.id !== 'plan-2');
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/printing/plan')) return Response.json({ entries: current });
      if (url.endsWith('/printing/printers')) return Response.json([]);
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetch);
    renderPlan(authenticatedClient());

    expect(await screen.findByRole('status')).toHaveTextContent(
      'This model or version is unavailable.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move Vase up' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/printing/plan/order') &&
            JSON.stringify(JSON.parse(String(init?.body)).entryIds) === '["plan-2","plan-1"]',
        ),
      ).toBe(true),
    );
    const removeButton = screen.getAllByRole('button', { name: 'Remove' }).at(0);
    if (!removeButton) throw new Error('Expected a remove button.');
    fireEvent.click(removeButton);
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) => String(url).endsWith('/plan/plan-2') && init?.method === 'DELETE',
        ),
      ).toBe(true),
    );
  });
});

function renderPlan(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PrintPlanPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function authenticatedClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(sessionQueryKey, {
    authenticated: true,
    setupRequired: false,
    owner: { id: 'owner-1', username: 'Owner' },
    csrfToken: 'csrf-session',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  return queryClient;
}

function planEntry(id: string, modelName: string, position: number, unavailable: boolean) {
  return {
    id,
    modelId: `model-${id}`,
    modelName,
    versionId: `version-${id}`,
    versionLabel: 'v1',
    assets: unavailable ? [] : [{ id: `asset-${id}`, filename: `${modelName}.gcode` }],
    position,
    unavailable,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}
