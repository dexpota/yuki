import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerLocalImportFeature } from '../../src/importing/feature.js';
import type { LocalImportService } from '../../src/importing/service.js';
import { createHttpApplication } from '../../src/platform/http/index.js';

describe('local import HTTP transport', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;

  afterEach(async () => application?.close());

  it('decodes percent-encoded Unicode upload metadata without changing existing plain clients', async () => {
    application = await createHttpApplication();
    const receive = vi.fn(async () => ({
      id: '10000000-0000-4000-8000-000000000001',
      state: 'queued' as const,
      originalFilename: 'Café model.stl',
      modelName: 'Café prototype',
      uploadedBytes: 5,
      checksum: 'a'.repeat(64),
      progress: 50,
      modelId: null,
      error: null,
      createdAt: new Date('2026-07-23T10:00:00Z'),
      updatedAt: new Date('2026-07-23T10:00:00Z'),
      completedAt: null,
    }));
    registerLocalImportFeature(application, {
      service: { receive } as unknown as LocalImportService,
      identity: {
        requireOwner: async () => undefined,
        ownerForRequest: () => ({
          owner: { id: '20000000-0000-4000-8000-000000000001', username: 'Owner' },
          sessionId: 'session-1',
        }),
      },
    });

    const response = await application.inject({
      method: 'POST',
      url: '/api/v1/imports/local',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yuki-value-encoding': 'percent',
        'x-yuki-filename': 'Caf%C3%A9%20model.stl',
        'x-yuki-model-name': 'Caf%C3%A9%20prototype',
        'x-yuki-claimed-mime-type': 'model/stl',
      },
      payload: Buffer.from('model'),
    });

    expect(response.statusCode).toBe(202);
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        originalFilename: 'Café model.stl',
        modelName: 'Café prototype',
        claimedMimeType: 'model/stl',
      }),
    );
  });

  it('rejects malformed encoded metadata as a client error', async () => {
    application = await createHttpApplication();
    registerLocalImportFeature(application, {
      service: {} as LocalImportService,
      identity: {
        requireOwner: async () => undefined,
        ownerForRequest: () => ({
          owner: { id: '20000000-0000-4000-8000-000000000001', username: 'Owner' },
          sessionId: 'session-1',
        }),
      },
    });

    const response = await application.inject({
      method: 'POST',
      url: '/api/v1/imports/local',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yuki-value-encoding': 'percent',
        'x-yuki-filename': '%not-valid',
        'x-yuki-model-name': 'Model',
      },
      payload: Buffer.from('model'),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('upload_header_invalid');
  });
});
