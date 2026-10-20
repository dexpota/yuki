import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpApplication, HttpError } from '../../../src/platform/http/index.js';
import {
  type PrintPlanningService,
  registerPrintPlanningFeature,
} from '../../../src/printing/planning/index.js';

describe('print planning HTTP contract', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;
  afterEach(async () => application?.close());

  it('requires an owner on every endpoint', async () => {
    application = await createHttpApplication();
    registerPrintPlanningFeature(application, {
      service: {} as PrintPlanningService,
      identity: {
        requireOwner: async () => {
          throw new HttpError(401, 'authentication_required', 'Authentication is required');
        },
        ownerForRequest: () => {
          throw new Error('Unauthenticated');
        },
      },
    });
    for (const request of [
      { method: 'GET' as const, url: '/api/v1/printing/plan' },
      {
        method: 'POST' as const,
        url: '/api/v1/printing/plan',
        payload: { modelId: 'm', versionId: 'v' },
      },
      { method: 'PUT' as const, url: '/api/v1/printing/plan/order', payload: { entryIds: [] } },
      { method: 'DELETE' as const, url: '/api/v1/printing/plan/e' },
    ])
      expect((await application.inject(request)).statusCode).toBe(401);
  });

  it('lists exact version G-code choices and forwards owner scoped mutations', async () => {
    const ownerId = uuid(1);
    const entry = {
      id: uuid(2),
      modelId: uuid(3),
      versionId: uuid(4),
      modelName: 'Vase',
      versionLabel: 'v2',
      unavailable: false,
      assets: [{ id: uuid(5), filename: 'vase.gcode' }],
      position: 0,
      createdAt: new Date('2026-10-20T00:00:00Z'),
    };
    const list = vi.fn(async () => [entry]);
    const create = vi.fn(async () => entry);
    const reorder = vi.fn(async () => [entry]);
    const remove = vi.fn(async () => {});
    application = await createHttpApplication();
    registerPrintPlanningFeature(application, {
      service: { list, create, reorder, remove } as unknown as PrintPlanningService,
      identity: {
        requireOwner: async () => {},
        ownerForRequest: () => ({ owner: { id: ownerId, username: 'owner' }, sessionId: uuid(6) }),
      },
    });
    expect(
      (await application.inject({ method: 'GET', url: '/api/v1/printing/plan' })).json(),
    ).toMatchObject({ entries: [{ unavailable: false, assets: [{ id: uuid(5) }] }] });
    expect(
      (
        await application.inject({
          method: 'POST',
          url: '/api/v1/printing/plan',
          payload: { modelId: uuid(3), versionId: uuid(4) },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await application.inject({
          method: 'PUT',
          url: '/api/v1/printing/plan/order',
          payload: { entryIds: [uuid(2)] },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await application.inject({ method: 'DELETE', url: `/api/v1/printing/plan/${uuid(2)}` }))
        .statusCode,
    ).toBe(204);
    expect(create).toHaveBeenCalledWith(ownerId, uuid(3), uuid(4));
    expect(reorder).toHaveBeenCalledWith(ownerId, [uuid(2)]);
    expect(remove).toHaveBeenCalledWith(ownerId, uuid(2));
  });
});

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
