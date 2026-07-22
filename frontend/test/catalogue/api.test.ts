import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  replaceCollections,
  restoreVersion,
  searchCatalogue,
  updateModel,
} from '../../src/catalogue/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('catalogue API', () => {
  it('encodes indexed filters and cursor paging', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ items: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetch);

    await searchCatalogue(
      {
        query: 'benchy',
        tagId: 'tag-1',
        collectionId: 'collection-1',
        favorite: true,
        format: 'stl',
        source: 'upload',
        printed: false,
        sort: 'printCount',
        direction: 'desc',
      },
      'next page',
    );

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    const query = new URL(url, 'http://yuki.local').searchParams;
    expect(url).toContain('/api/v1/catalogue/models?');
    expect(Object.fromEntries(query)).toMatchObject({
      q: 'benchy',
      tagId: 'tag-1',
      collectionId: 'collection-1',
      favorite: 'true',
      format: 'stl',
      source: 'upload',
      printed: 'false',
      sort: 'printCount',
      direction: 'desc',
      cursor: 'next page',
      limit: '24',
    });
    expect(init.credentials).toBe('include');
  });

  it('sends edit and relationship commands with CSRF protection', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({})));
    vi.stubGlobal('fetch', fetch);

    await updateModel('model/1', { name: 'New name', favorite: true }, 'csrf-value');
    await replaceCollections('model/1', ['collection-1'], 'csrf-value');
    await restoreVersion('model/1', 'version-2', 'csrf-value');

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/catalogue/models/model%2F1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: 'New name', favorite: true }),
        credentials: 'include',
      }),
    );
    const firstHeaders = fetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(firstHeaders.get('x-csrf-token')).toBe('csrf-value');
    expect(firstHeaders.get('content-type')).toBe('application/json');
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ collectionIds: ['collection-1'] }),
    );
    expect(fetch.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ versionId: 'version-2' }));
  });
});
