import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpApplication, HttpError } from '../../../src/platform/http/index.js';
import {
  type QueueEntryView,
  type QueueService,
  registerQueueFeature,
} from '../../../src/printing/queue/index.js';

describe('printing queue HTTP contract', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;

  afterEach(async () => application?.close());

  it('protects every queue endpoint with the owner boundary', async () => {
    application = await createHttpApplication();
    registerQueueFeature(application, {
      service: {} as QueueService,
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
      { method: 'GET' as const, url: `/api/v1/printing/printers/${uuid(1)}/queue` },
      { method: 'POST' as const, url: `/api/v1/printing/printers/${uuid(1)}/queue` },
      { method: 'PUT' as const, url: `/api/v1/printing/printers/${uuid(1)}/queue/order` },
      {
        method: 'POST' as const,
        url: `/api/v1/printing/printers/${uuid(1)}/queue/${uuid(2)}/override`,
      },
      {
        method: 'DELETE' as const,
        url: `/api/v1/printing/printers/${uuid(1)}/queue/${uuid(2)}`,
      },
    ]) {
      const response = await application.inject(request);
      expect(response.statusCode).toBe(401);
    }
  });

  it('queues evaluation with idempotency and exposes sanitized state', async () => {
    application = await createHttpApplication();
    const request = vi.fn(async () => entry());
    registerQueueFeature(application, {
      service: {
        request,
        list: async () => [entry()],
      } as unknown as QueueService,
      identity: {
        requireOwner: async () => {},
        ownerForRequest: () => ({
          owner: { id: uuid(9), username: 'owner' },
          sessionId: uuid(8),
        }),
      },
    });
    const queued = await application.inject({
      method: 'POST',
      url: `/api/v1/printing/printers/${uuid(1)}/queue`,
      headers: { 'idempotency-key': 'queue-once' },
      payload: { assetId: uuid(2) },
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({
      id: uuid(3),
      state: 'evaluating',
      position: null,
    });
    expect(JSON.stringify(queued.json())).not.toContain('evaluation_job_id');
    expect(request).toHaveBeenCalledWith({
      ownerId: uuid(9),
      printerId: uuid(1),
      assetId: uuid(2),
      idempotencyKey: 'queue-once',
    });
  });
});

function entry(): QueueEntryView {
  const now = new Date('2026-07-23T12:00:00.000Z');
  return {
    id: uuid(3),
    printerId: uuid(1),
    assetId: uuid(2),
    state: 'evaluating',
    position: null,
    compatibilityStatus: null,
    compatibilitySnapshot: null,
    overrideJustification: null,
    printAttemptId: null,
    upstreamPath: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
