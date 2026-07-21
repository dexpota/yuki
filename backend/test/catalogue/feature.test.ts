import type { Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import {
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

    expect(read.statusCode).toBe(401);
    expect(read.json().error.code).toBe('authentication_required');
    expect(mutation.statusCode).toBe(401);
    expect(mutation.json().error.code).toBe('authentication_required');
  });
});
