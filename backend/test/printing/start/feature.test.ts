import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpApplication, HttpError } from '../../../src/platform/http/index.js';
import {
  type PrintStartService,
  registerPrintStartFeature,
  remoteStartSafetyNotice,
} from '../../../src/printing/start/index.js';

describe('print start HTTP contract', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;

  afterEach(async () => application?.close());

  it('protects confirmation and start endpoints with the owner boundary', async () => {
    application = await createHttpApplication();
    registerPrintStartFeature(application, {
      service: {} as PrintStartService,
      identity: {
        requireOwner: async () => {
          throw new HttpError(401, 'authentication_required', 'Authentication is required');
        },
        ownerForRequest: () => {
          throw new Error('Unauthenticated requests have no owner');
        },
      },
    });
    for (const suffix of ['start-confirmations', 'start']) {
      const response = await application.inject({
        method: 'POST',
        url: `/api/v1/printing/print-jobs/${uuid(1)}/${suffix}`,
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('returns a complete safety challenge and accepts it idempotently', async () => {
    application = await createHttpApplication();
    const issue = vi.fn(async () => ({
      token: 'token',
      expiresAt: new Date('2026-07-28T12:02:00.000Z'),
      printer: { id: uuid(2), name: 'Workshop' },
      file: { assetId: uuid(3), filename: 'cube.gcode', byteSize: 123 },
      compatibilityStatus: 'warning',
      warnings: ['Nozzle metadata differs'],
      safetyNotice: remoteStartSafetyNotice,
    }));
    const accept = vi.fn(async () => ({
      queueEntryId: uuid(1),
      printAttemptId: uuid(4),
      state: 'uploading' as const,
    }));
    registerPrintStartFeature(application, {
      service: { issue, accept } as unknown as PrintStartService,
      identity: {
        requireOwner: async () => {},
        ownerForRequest: () => ({
          owner: { id: uuid(9), username: 'owner' },
          sessionId: uuid(8),
        }),
      },
    });

    const challenge = await application.inject({
      method: 'POST',
      url: `/api/v1/printing/print-jobs/${uuid(1)}/start-confirmations`,
    });
    expect(challenge.statusCode).toBe(201);
    expect(challenge.json()).toMatchObject({
      printer: { name: 'Workshop' },
      file: { filename: 'cube.gcode' },
      warnings: ['Nozzle metadata differs'],
      safetyNotice: remoteStartSafetyNotice,
    });

    const started = await application.inject({
      method: 'POST',
      url: `/api/v1/printing/print-jobs/${uuid(1)}/start`,
      headers: { 'idempotency-key': 'start-once' },
      payload: { confirmationToken: 'confirmation-token' },
    });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({
      queueEntryId: uuid(1),
      printAttemptId: uuid(4),
      state: 'uploading',
    });
    expect(accept).toHaveBeenCalledWith(uuid(9), uuid(1), 'confirmation-token', 'start-once');
  });
});

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
