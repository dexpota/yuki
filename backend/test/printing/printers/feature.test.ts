import type { Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpApplication, HttpError } from '../../../src/platform/http/index.js';

import {
  type PrinterDatabaseSchema,
  registerPrinterFeature,
} from '../../../src/printing/printers/public.js';

describe('printer HTTP authentication boundary', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;
  afterEach(async () => application?.close());

  it('rejects access before printer code receives an owner or a secret', async () => {
    application = await createHttpApplication();
    registerPrinterFeature(application, {
      database: {} as Kysely<PrinterDatabaseSchema>,
      identity: {
        requireOwner: async () => {
          throw new HttpError(401, 'authentication_required', 'Authentication is required');
        },
        ownerForRequest: () => {
          throw new Error('Unauthenticated request must not receive owner context');
        },
      },
      secrets: {
        encrypt: () => {
          throw new Error('Unauthenticated request must not encrypt');
        },
        decrypt: () => {
          throw new Error('Unauthenticated request must not decrypt');
        },
      },
    });
    const read = await application.inject({ method: 'GET', url: '/api/v1/printing/printers' });
    const write = await application.inject({
      method: 'POST',
      url: '/api/v1/printing/printers',
      payload: {},
    });
    expect(read.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);
  });
});
