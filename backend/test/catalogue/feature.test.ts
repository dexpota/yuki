import { Readable } from 'node:stream';

import type { Kysely } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type CatalogueAssetDownloads,
  type CatalogueDatabaseSchema,
  registerCatalogueFeature,
} from '../../src/catalogue/index.js';
import { createHttpApplication, HttpError } from '../../src/platform/http/index.js';

describe('catalogue HTTP authentication boundary', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;

  afterEach(async () => application?.close());

  it('rejects reads and mutations before catalogue code receives an owner', async () => {
    application = await createHttpApplication();
    registerCatalogueFeature(application, {
      // Authentication runs before either handler touches persistence.
      database: {} as Kysely<CatalogueDatabaseSchema>,
      identity: {
        requireOwner: async () => {
          throw new HttpError(401, 'authentication_required', 'Authentication is required');
        },
        ownerForRequest: () => {
          throw new Error('Unauthenticated requests must not obtain owner context');
        },
      },
    });

    const read = await application.inject({
      method: 'GET',
      url: '/api/v1/catalogue/models/21000000-0000-4000-8000-000000000001',
    });
    const mutation = await application.inject({
      method: 'PATCH',
      url: '/api/v1/catalogue/models/21000000-0000-4000-8000-000000000001',
      payload: { favorite: true },
    });
    const tags = await application.inject({ method: 'GET', url: '/api/v1/catalogue/tags' });
    const collections = await application.inject({
      method: 'GET',
      url: '/api/v1/catalogue/collections',
    });
    const download = await application.inject({
      method: 'GET',
      url: '/api/v1/catalogue/assets/21000000-0000-4000-8000-000000000002/download',
    });

    expect(read.statusCode).toBe(401);
    expect(read.json().error.code).toBe('authentication_required');
    expect(mutation.statusCode).toBe(401);
    expect(mutation.json().error.code).toBe('authentication_required');
    expect(tags.statusCode).toBe(401);
    expect(collections.statusCode).toBe(401);
    expect(download.statusCode).toBe(401);
  });

  it('streams an owner-scoped original asset with immutable range headers', async () => {
    application = await createHttpApplication();
    const open = vi.fn(async () => ({
      filename: 'Café "cube".stl',
      mimeType: 'model/stl',
      byteSize: 10,
      checksum: 'a'.repeat(64),
      range: { start: 2, end: 5 },
      stream: Readable.from([Buffer.from('2345')]),
    }));
    registerCatalogueFeature(application, {
      database: {} as Kysely<CatalogueDatabaseSchema>,
      assetDownloads: { open } as unknown as CatalogueAssetDownloads,
      identity: {
        requireOwner: async () => undefined,
        ownerForRequest: () => ({
          owner: { id: 'owner-1', username: 'Owner' },
          sessionId: 'session-1',
        }),
      },
    });

    const response = await application.inject({
      method: 'GET',
      url: '/api/v1/catalogue/assets/21000000-0000-4000-8000-000000000002/download',
      headers: { range: 'bytes=2-5' },
    });

    expect(open).toHaveBeenCalledWith('owner-1', '21000000-0000-4000-8000-000000000002', {
      start: 2,
      end: 5,
    });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe('2345');
    expect(response.headers).toMatchObject({
      'accept-ranges': 'bytes',
      'content-length': '4',
      'content-range': 'bytes 2-5/10',
      etag: `"${'a'.repeat(64)}"`,
      'cache-control': 'private, max-age=31536000, immutable',
    });
    expect(response.headers['content-disposition']).toContain(
      "filename*=UTF-8''Caf%C3%A9%20%22cube%22.stl",
    );
  });
});
