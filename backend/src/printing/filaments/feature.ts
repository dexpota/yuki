import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OwnerContext } from '../../identity/index.js';
import { HttpError } from '../../platform/http/index.js';
import type { FilamentPresetInput } from './preset.js';
import {
  FilamentPresetConflictError,
  FilamentPresetNotFoundError,
  type FilamentPresetService,
  type FilamentPresetView,
  type UpdateFilamentPresetInput,
} from './service.js';

export interface FilamentPresetIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export function registerFilamentPresetFeature(
  application: FastifyInstance,
  options: {
    readonly identity: FilamentPresetIdentityBoundary;
    readonly service: FilamentPresetService;
  },
): void {
  const authenticated = { preHandler: options.identity.requireOwner };
  const ownerId = (request: FastifyRequest) => options.identity.ownerForRequest(request).owner.id;

  application.get('/api/v1/printing/filament-presets', authenticated, async (request) => ({
    presets: (
      await call(() =>
        options.service.list(ownerId(request), {
          includeArchived: includeArchived(request.query),
        }),
      )
    ).map(response),
  }));

  application.post('/api/v1/printing/filament-presets', authenticated, async (request, reply) => {
    const preset = await call(() =>
      options.service.create(ownerId(request), createInput(request.body)),
    );
    return reply.status(201).send(response(preset));
  });

  application.patch('/api/v1/printing/filament-presets/:presetId', authenticated, async (request) =>
    response(
      await call(() =>
        options.service.update(ownerId(request), pathId(request), updateInput(request.body)),
      ),
    ),
  );

  for (const action of ['archive', 'restore'] as const)
    application.post(
      `/api/v1/printing/filament-presets/:presetId/${action}`,
      authenticated,
      async (request) =>
        response(
          await call(() =>
            options.service[action](ownerId(request), pathId(request), versionBody(request.body)),
          ),
        ),
    );
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof FilamentPresetNotFoundError)
      throw new HttpError(404, 'filament_preset_not_found', error.message);
    if (error instanceof FilamentPresetConflictError)
      throw new HttpError(409, 'filament_preset_conflict', error.message);
    if (error instanceof TypeError)
      throw new HttpError(400, 'filament_preset_request_invalid', error.message);
    throw error;
  }
}

function createInput(value: unknown): FilamentPresetInput {
  const body = objectBody(value);
  exactKeys(body, presetKeys);
  return {
    displayName: requiredString(body.displayName, 'displayName'),
    material: requiredString(body.material, 'material'),
    ...(body.colorName === undefined
      ? {}
      : { colorName: optionalString(body.colorName, 'colorName') }),
    ...(body.colorHex === undefined ? {} : { colorHex: optionalString(body.colorHex, 'colorHex') }),
    ...(body.manufacturer === undefined
      ? {}
      : { manufacturer: optionalString(body.manufacturer, 'manufacturer') }),
    ...(body.productName === undefined
      ? {}
      : { productName: optionalString(body.productName, 'productName') }),
    ...(body.diameterMm === undefined
      ? {}
      : { diameterMm: optionalNumber(body.diameterMm, 'diameterMm') }),
    ...(body.notes === undefined ? {} : { notes: requiredString(body.notes, 'notes') }),
  };
}

function updateInput(value: unknown): UpdateFilamentPresetInput {
  const body = objectBody(value);
  exactKeys(body, [...presetKeys, 'expectedVersion']);
  const expectedVersion = version(body.expectedVersion);
  const result: UpdateFilamentPresetInput = {
    expectedVersion,
    ...(body.displayName === undefined
      ? {}
      : { displayName: requiredString(body.displayName, 'displayName') }),
    ...(body.material === undefined ? {} : { material: requiredString(body.material, 'material') }),
    ...(body.colorName === undefined
      ? {}
      : { colorName: optionalString(body.colorName, 'colorName') }),
    ...(body.colorHex === undefined ? {} : { colorHex: optionalString(body.colorHex, 'colorHex') }),
    ...(body.manufacturer === undefined
      ? {}
      : { manufacturer: optionalString(body.manufacturer, 'manufacturer') }),
    ...(body.productName === undefined
      ? {}
      : { productName: optionalString(body.productName, 'productName') }),
    ...(body.diameterMm === undefined
      ? {}
      : { diameterMm: optionalNumber(body.diameterMm, 'diameterMm') }),
    ...(body.notes === undefined ? {} : { notes: requiredString(body.notes, 'notes') }),
  };
  if (Object.keys(result).length === 1)
    throw new TypeError('At least one filament field is required');
  return result;
}

function versionBody(value: unknown): number {
  const body = objectBody(value);
  exactKeys(body, ['expectedVersion']);
  return version(body.expectedVersion);
}

function includeArchived(value: unknown): boolean {
  const query = objectBody(value);
  exactKeys(query, ['includeArchived']);
  if (query.includeArchived === undefined || query.includeArchived === 'false') return false;
  if (query.includeArchived === 'true') return true;
  throw new TypeError('includeArchived must be true or false');
}

function response(preset: FilamentPresetView) {
  return {
    ...preset,
    archivedAt: preset.archivedAt?.toISOString() ?? null,
    createdAt: preset.createdAt.toISOString(),
    updatedAt: preset.updatedAt.toISOString(),
  };
}

const presetKeys = [
  'displayName',
  'material',
  'colorName',
  'colorHex',
  'manufacturer',
  'productName',
  'diameterMm',
  'notes',
] as const;

function pathId(request: FastifyRequest): string {
  return requiredString(objectBody(request.params).presetId, 'presetId');
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new TypeError('expectedVersion must be a positive integer');
  return Number(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requiredString(value, name);
}

function optionalNumber(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(`${name} must be a number or null`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new TypeError('Filament preset body contains unsupported fields');
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Request body must be an object');
  return value as Record<string, unknown>;
}
