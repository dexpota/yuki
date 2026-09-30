import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpApplication, HttpError } from '../../../src/platform/http/index.js';
import {
  type FilamentPresetService,
  type FilamentPresetView,
  registerFilamentPresetFeature,
} from '../../../src/printing/filaments/index.js';

describe('filament preset HTTP contract', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;

  afterEach(async () => application?.close());

  it('protects every endpoint with the owner boundary', async () => {
    application = await createHttpApplication();
    registerFilamentPresetFeature(application, {
      service: {} as FilamentPresetService,
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
      { method: 'GET' as const, url: '/api/v1/printing/filament-presets' },
      { method: 'POST' as const, url: '/api/v1/printing/filament-presets' },
      { method: 'PATCH' as const, url: `/api/v1/printing/filament-presets/${uuid(1)}` },
      { method: 'POST' as const, url: `/api/v1/printing/filament-presets/${uuid(1)}/archive` },
      { method: 'POST' as const, url: `/api/v1/printing/filament-presets/${uuid(1)}/restore` },
    ]) {
      expect((await application.inject(request)).statusCode).toBe(401);
    }
  });

  it('validates the boundary and exposes normalized public values', async () => {
    application = await createHttpApplication();
    const create = vi.fn(async () => preset());
    const list = vi.fn(async () => [preset()]);
    registerFilamentPresetFeature(application, {
      service: { create, list } as unknown as FilamentPresetService,
      identity: {
        requireOwner: async () => {},
        ownerForRequest: () => ({
          owner: { id: uuid(9), username: 'owner' },
          sessionId: uuid(8),
        }),
      },
    });
    const created = await application.inject({
      method: 'POST',
      url: '/api/v1/printing/filament-presets',
      payload: { displayName: 'Galaxy Black', material: 'PLA', colorHex: '#1f2020' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      id: uuid(1),
      displayName: 'Galaxy Black',
      archivedAt: null,
      createdAt: '2026-09-30T10:00:00.000Z',
    });
    expect(create).toHaveBeenCalledWith(uuid(9), {
      displayName: 'Galaxy Black',
      material: 'PLA',
      colorHex: '#1f2020',
    });

    const archived = await application.inject({
      method: 'GET',
      url: '/api/v1/printing/filament-presets?includeArchived=true',
    });
    expect(archived.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(uuid(9), { includeArchived: true });

    const invalid = await application.inject({
      method: 'POST',
      url: '/api/v1/printing/filament-presets',
      payload: { displayName: 'PLA', material: 'PLA', remainingGrams: 500 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('filament_preset_request_invalid');

    const invalidArchive = await application.inject({
      method: 'POST',
      url: `/api/v1/printing/filament-presets/${uuid(1)}/archive`,
      payload: { expectedVersion: 0 },
    });
    expect(invalidArchive.statusCode).toBe(400);
    expect(invalidArchive.json().error.code).toBe('filament_preset_request_invalid');
  });
});

function preset(): FilamentPresetView {
  const now = new Date('2026-09-30T10:00:00.000Z');
  return {
    id: uuid(1),
    displayName: 'Galaxy Black',
    material: 'PLA',
    colorName: 'Galaxy Black',
    colorHex: '1f2020',
    manufacturer: 'Prusa Polymers',
    productName: 'Prusament PLA',
    diameterMm: 1.75,
    notes: '',
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
