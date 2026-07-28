import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpApplication, HttpError } from '../../../src/platform/http/index.js';
import {
  type PrintHistoryService,
  registerPrintHistoryFeature,
} from '../../../src/printing/history/index.js';

describe('print history HTTP contract', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;

  afterEach(async () => application?.close());

  it('protects history reads and mutations with the owner boundary', async () => {
    application = await createHttpApplication();
    registerPrintHistoryFeature(application, {
      service: {} as PrintHistoryService,
      identity: {
        requireOwner: async () => {
          throw new HttpError(401, 'authentication_required', 'Authentication is required');
        },
        ownerForRequest: () => {
          throw new Error('Unauthenticated requests have no owner');
        },
      },
    });
    for (const request of [
      { method: 'GET' as const, url: '/api/v1/printing/print-attempts' },
      { method: 'POST' as const, url: '/api/v1/printing/print-attempts' },
      {
        method: 'POST' as const,
        url: `/api/v1/printing/print-attempts/${uuid(1)}/outcome-corrections`,
      },
      {
        method: 'PUT' as const,
        url: `/api/v1/printing/print-attempts/${uuid(1)}/notes`,
      },
      {
        method: 'POST' as const,
        url: `/api/v1/printing/print-attempts/${uuid(1)}/photos`,
      },
    ]) {
      expect((await application.inject(request)).statusCode).toBe(401);
    }
  });

  it('validates and forwards a manual attempt with idempotency', async () => {
    const createManual = vi.fn(async () => attempt());
    application = await createHttpApplication();
    registerPrintHistoryFeature(application, {
      service: { createManual } as unknown as PrintHistoryService,
      identity: {
        requireOwner: async () => {},
        ownerForRequest: () => ({
          owner: { id: uuid(9), username: 'owner' },
          sessionId: uuid(8),
        }),
      },
    });
    const response = await application.inject({
      method: 'POST',
      url: '/api/v1/printing/print-attempts',
      headers: { 'idempotency-key': 'manual-once' },
      payload: {
        modelId: uuid(1),
        modelVersionId: uuid(2),
        assetId: uuid(3),
        printerId: uuid(4),
        source: 'manual',
        startedAt: '2026-07-27T10:00:00.000Z',
        completedAt: '2026-07-27T11:00:00.000Z',
        outcome: 'successful',
        notes: 'Good print',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: uuid(5),
      source: 'manual',
      outcome: 'successful',
      photos: [],
    });
    expect(createManual).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: uuid(9), idempotencyKey: 'manual-once' }),
    );
  });
});

function attempt() {
  const startedAt = new Date('2026-07-27T10:00:00.000Z');
  const completedAt = new Date('2026-07-27T11:00:00.000Z');
  return {
    id: uuid(5),
    source: 'manual' as const,
    queueEntryId: null,
    printerId: uuid(4),
    modelId: uuid(1),
    modelVersionId: uuid(2),
    assetId: uuid(3),
    state: 'completed',
    outcome: 'successful' as const,
    notes: 'Good print',
    statistics: {},
    printerSnapshot: {},
    modelSnapshot: {},
    assetSnapshot: {},
    compatibilitySnapshot: {},
    overrideJustification: null,
    startedAt,
    completedAt,
    createdAt: completedAt,
    updatedAt: completedAt,
    version: 1,
    photos: [],
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
