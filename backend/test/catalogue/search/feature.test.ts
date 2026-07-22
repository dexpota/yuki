import type { Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import type { CatalogueDatabaseSchema } from '../../../src/catalogue/schema.js';
import { registerCatalogueSearchFeature } from '../../../src/catalogue/search/index.js';
import { createHttpApplication, HttpError } from '../../../src/platform/http/index.js';

describe('catalogue search HTTP boundary', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;

  afterEach(async () => application?.close());

  it('requires an authenticated owner before searching', async () => {
    application = await createHttpApplication();
    registerCatalogueSearchFeature(application, {
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

    const response = await application.inject({
      method: 'GET',
      url: '/api/v1/catalogue/models?q=cube',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('authentication_required');
  });

  it('returns the stable search validation error before accessing persistence', async () => {
    application = await createHttpApplication();
    registerCatalogueSearchFeature(application, {
      database: {} as Kysely<CatalogueDatabaseSchema>,
      identity: {
        requireOwner: async () => undefined,
        ownerForRequest: () => ({
          owner: {
            id: '10000000-0000-4000-8000-000000000001',
            username: 'owner',
          },
          sessionId: '11000000-0000-4000-8000-000000000001',
        }),
      },
    });

    const response = await application.inject({
      method: 'GET',
      url: '/api/v1/catalogue/models?sort=unsupported',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('catalogue_search_invalid');
  });
});
