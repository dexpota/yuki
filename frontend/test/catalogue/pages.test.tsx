import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CataloguePage, ModelPage } from '../../src/catalogue/index.js';
import { sessionQueryKey } from '../../src/settings/identity/api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('catalogue pages', () => {
  it('searches and incrementally loads catalogue results', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/tags') || url.endsWith('/collections')) return Response.json([]);
      const cursor = new URL(url, 'http://yuki.local').searchParams.get('cursor');
      return Response.json({
        items: [item(cursor ? 'model-2' : 'model-1', cursor ? 'Second model' : 'Benchy')],
        nextCursor: cursor ? null : 'page-2',
      });
    });
    vi.stubGlobal('fetch', fetch);
    renderPage(<CataloguePage />);

    expect(await screen.findByRole('link', { name: /Benchy/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'boat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url]) => new URL(String(url), 'http://yuki').searchParams.get('q') === 'boat',
        ),
      ).toBe(true),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: /Second model/ })).toBeInTheDocument();
    expect(
      fetch.mock.calls.some(
        ([url]) => new URL(String(url), 'http://yuki').searchParams.get('cursor') === 'page-2',
      ),
    ).toBe(true);
  });

  it('edits metadata and restores an immutable version', async () => {
    const detail = modelDetail();
    const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/collections')) return Response.json([]);
      return Response.json(detail);
    });
    vi.stubGlobal('fetch', fetch);
    const queryClient = client();
    queryClient.setQueryData(sessionQueryKey, {
      authenticated: true,
      setupRequired: false,
      owner: { id: 'owner-1', username: 'Owner' },
      csrfToken: 'csrf-session',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    renderPage(<ModelPage />, queryClient, '/catalogue/models/model-1');

    expect(await screen.findByRole('heading', { name: 'Benchy', level: 1 })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Better Benchy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/models/model-1') &&
            init?.method === 'PATCH' &&
            String(init.body).includes('Better Benchy'),
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Restore as current' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/current-version') &&
            init?.body === JSON.stringify({ versionId: 'version-1' }),
        ),
      ).toBe(true),
    );
  });
});

function renderPage(node: React.ReactNode, queryClient = client(), path = '/') {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path={path.startsWith('/catalogue/models/') ? '/catalogue/models/:modelId' : '*'}
            element={node}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function item(id: string, name: string) {
  return {
    id,
    name,
    description: '',
    creator: null,
    sourceUrl: null,
    importSource: 'upload',
    favorite: false,
    currentVersionId: 'version-2',
    coverAssetId: null,
    printCount: 0,
    lastPrintedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function modelDetail() {
  return {
    model: {
      id: 'model-1',
      name: 'Benchy',
      description: 'A small boat',
      import_source: 'upload',
      source_url: null,
      creator: null,
      license: null,
      favorite: false,
      current_version_id: 'version-2',
      print_count: 0,
      last_printed_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    },
    versions: [
      {
        id: 'version-2',
        model_id: 'model-1',
        label: 'v2',
        change_note: null,
        metadata_schema_version: 1,
        metadata_snapshot: {},
        created_at: '2026-01-02T00:00:00.000Z',
        published_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'version-1',
        model_id: 'model-1',
        label: 'v1',
        change_note: 'First',
        metadata_schema_version: 1,
        metadata_snapshot: {},
        created_at: '2026-01-01T00:00:00.000Z',
        published_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    assets: [],
    tags: [{ id: 'tag-1', name: 'Boat' }],
    collections: [],
  };
}
