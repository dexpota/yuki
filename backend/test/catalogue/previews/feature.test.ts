import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ArtifactView,
  type CataloguePreviewOperations,
  registerCataloguePreviewFeature,
} from '../../../src/catalogue/previews/index.js';
import { createHttpApplication, HttpError } from '../../../src/platform/http/index.js';

describe('catalogue preview HTTP contract', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;

  afterEach(async () => application?.close());

  it('protects request, status, and download endpoints with the owner boundary', async () => {
    application = await createHttpApplication();
    registerCataloguePreviewFeature(application, {
      operations: {} as CataloguePreviewOperations,
      identity: {
        requireOwner: async () => {
          throw new HttpError(401, 'authentication_required', 'Authentication is required');
        },
        ownerForRequest: () => {
          throw new Error('An unauthenticated request has no owner');
        },
      },
    });
    for (const request of [
      { method: 'POST' as const, url: `/api/v1/catalogue/assets/${uuid(1)}/previews` },
      { method: 'GET' as const, url: `/api/v1/catalogue/assets/${uuid(1)}/previews` },
      { method: 'GET' as const, url: `/api/v1/catalogue/previews/${uuid(2)}/download` },
    ]) {
      const response = await application.inject(request);
      expect(response.statusCode).toBe(401);
    }
  });

  it('returns sanitized artifact status and streams ready output', async () => {
    application = await createHttpApplication();
    const artifact = view();
    const request = vi.fn(async () => [artifact]);
    registerCataloguePreviewFeature(application, {
      operations: {
        request,
        list: async () => [artifact],
        download: async () => ({
          filename: 'preview.glb',
          mimeType: 'model/gltf-binary',
          byteSize: 3,
          stream: Readable.from([Buffer.from('glb')]),
        }),
      } as unknown as CataloguePreviewOperations,
      identity: {
        requireOwner: async () => {},
        ownerForRequest: () => ({
          owner: { id: uuid(9), username: 'owner' },
          sessionId: uuid(8),
        }),
      },
    });

    const requested = await application.inject({
      method: 'POST',
      url: `/api/v1/catalogue/assets/${uuid(1)}/previews`,
    });
    expect(requested.statusCode).toBe(202);
    expect(requested.json()).toEqual({
      artifacts: [
        expect.objectContaining({
          id: artifact.id,
          status: 'ready',
          downloadUrl: `/api/v1/catalogue/previews/${artifact.id}/download`,
        }),
      ],
    });
    expect(JSON.stringify(requested.json())).not.toContain('storedObjectId');
    expect(request).toHaveBeenCalledWith(uuid(9), uuid(1));

    const downloaded = await application.inject({
      method: 'GET',
      url: `/api/v1/catalogue/previews/${uuid(2)}/download`,
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-type']).toBe('model/gltf-binary');
    expect(downloaded.body).toBe('glb');
  });
});

function view(): ArtifactView {
  return {
    id: uuid(2),
    sourceAssetId: uuid(1),
    kind: 'geometry_preview',
    generator: 'yuki-preview',
    generatorVersion: '1',
    status: 'ready',
    storedObjectId: uuid(3),
    mimeType: 'model/gltf-binary',
    byteSize: 3,
    dimensions: { width: 1, depth: 2, height: 3, unit: 'mm' },
    summary: null,
    failure: null,
    attempt: 1,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
