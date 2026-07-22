import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type CataloguePortabilityOperations,
  registerCataloguePortabilityFeature,
} from '../../../src/catalogue/portability/index.js';
import { createHttpApplication, HttpError } from '../../../src/platform/http/index.js';

describe('catalogue portability HTTP contract', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;
  afterEach(async () => application?.close());

  it('protects enqueue, status and download endpoints with the owner boundary', async () => {
    application = await createHttpApplication();
    registerCataloguePortabilityFeature(application, {
      operations: {} as CataloguePortabilityOperations,
      identity: {
        requireOwner: async () => {
          throw new HttpError(401, 'authentication_required', 'Authentication is required');
        },
        ownerForRequest: () => {
          throw new Error('An unauthenticated request has no owner');
        },
      },
    });
    const paths = [
      { method: 'POST' as const, url: `/api/v1/catalogue/models/${uuid(1)}/exports` },
      { method: 'GET' as const, url: `/api/v1/catalogue/portability/${uuid(2)}` },
      { method: 'GET' as const, url: `/api/v1/catalogue/portability/${uuid(2)}/download` },
    ];
    for (const request of paths) {
      const response = await application.inject(request);
      expect(response.statusCode).toBe(401);
    }
  });

  it('returns accepted operation contracts and never exposes object keys', async () => {
    application = await createHttpApplication();
    const operation = view();
    const enqueueExport = vi.fn(async () => operation);
    const receiveImport = vi.fn(async (_owner: string, source: AsyncIterable<Uint8Array>) => {
      for await (const _chunk of source) {
        // Consume the streaming request as the real storage adapter does.
      }
      return { ...operation, kind: 'import' as const };
    });
    registerCataloguePortabilityFeature(application, {
      operations: {
        enqueueExport,
        receiveImport,
        get: async () => operation,
        download: async () => ({ filename: 'cube.yuki.zip', stream: Readable.from(['zip']) }),
      } as unknown as CataloguePortabilityOperations,
      identity: {
        requireOwner: async () => {},
        ownerForRequest: () => ({
          owner: { id: uuid(9), username: 'owner' },
          sessionId: uuid(8),
        }),
      },
    });

    const exported = await application.inject({
      method: 'POST',
      url: `/api/v1/catalogue/models/${uuid(1)}/exports`,
      headers: { 'idempotency-key': 'export-once' },
    });
    expect(exported.statusCode).toBe(202);
    expect(exported.json()).toMatchObject({
      id: operation.id,
      state: 'queued',
      downloadReady: false,
    });
    expect(JSON.stringify(exported.json())).not.toContain('object_key');
    expect(enqueueExport).toHaveBeenCalledWith(uuid(9), uuid(1), 'export-once');

    const imported = await application.inject({
      method: 'POST',
      url: '/api/v1/catalogue/imports',
      headers: { 'content-type': 'application/vnd.yuki.model+zip' },
      payload: Buffer.from('package'),
    });
    expect(imported.statusCode).toBe(202);
    expect(receiveImport).toHaveBeenCalled();
  });
});

function view() {
  const now = new Date('2026-07-22T00:00:00.000Z');
  return {
    id: uuid(2),
    kind: 'export' as const,
    state: 'queued' as const,
    sourceModelId: uuid(1),
    importedModelId: null,
    progress: 0,
    downloadReady: false,
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}
function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
