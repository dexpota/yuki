import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';

import type { OwnerContext } from '../identity/index.js';
import { HttpError } from '../platform/http/index.js';
import type {
  CatalogueAssetFormat,
  CatalogueAssetRole,
  CatalogueDatabaseSchema,
} from './schema.js';
import {
  CatalogueConflictError,
  type CatalogueDeletionPolicy,
  CatalogueNotFoundError,
  CatalogueService,
  type CatalogueServiceOptions,
  type CatalogueVersionInput,
  type CreateModelInput,
  type UpdateModelInput,
} from './service.js';

export interface CatalogueIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export interface CatalogueFeatureOptions {
  readonly database: Kysely<CatalogueDatabaseSchema>;
  readonly identity: CatalogueIdentityBoundary;
  readonly deletionPolicy?: CatalogueDeletionPolicy;
  readonly service?: Omit<CatalogueServiceOptions, 'deletionPolicy'>;
}

export interface CatalogueFeature {
  readonly service: CatalogueService;
}

export function registerCatalogueFeature(
  application: FastifyInstance,
  options: CatalogueFeatureOptions,
): CatalogueFeature {
  const service = new CatalogueService(options.database, {
    ...options.service,
    ...(options.deletionPolicy === undefined ? {} : { deletionPolicy: options.deletionPolicy }),
  });
  const authenticated = { preHandler: options.identity.requireOwner };
  const ownerId = (request: FastifyRequest) => options.identity.ownerForRequest(request).owner.id;

  application.post('/api/v1/catalogue/models', authenticated, async (request, reply) => {
    const result = await call(() =>
      service.createModel(ownerId(request), createModelBody(request.body)),
    );
    return reply.status(201).send(result);
  });

  application.get('/api/v1/catalogue/models/:modelId', authenticated, async (request) =>
    call(() => service.getModel(ownerId(request), pathId(request, 'modelId'))),
  );

  application.patch('/api/v1/catalogue/models/:modelId', authenticated, async (request) =>
    call(() =>
      service.updateModel(
        ownerId(request),
        pathId(request, 'modelId'),
        updateModelBody(request.body),
      ),
    ),
  );

  application.delete('/api/v1/catalogue/models/:modelId', authenticated, async (request, reply) => {
    await call(() => service.deleteModel(ownerId(request), pathId(request, 'modelId')));
    return reply.status(204).send();
  });

  application.post(
    '/api/v1/catalogue/models/:modelId/versions',
    authenticated,
    async (request, reply) => {
      const result = await call(() =>
        service.addVersion(ownerId(request), pathId(request, 'modelId'), versionBody(request.body)),
      );
      return reply.status(201).send(result);
    },
  );

  application.put(
    '/api/v1/catalogue/models/:modelId/current-version',
    authenticated,
    async (request) => {
      const body = objectBody(request.body);
      return call(() =>
        service.restoreVersion(
          ownerId(request),
          pathId(request, 'modelId'),
          requiredString(body.versionId, 'versionId'),
        ),
      );
    },
  );

  application.put('/api/v1/catalogue/models/:modelId/tags', authenticated, async (request) => {
    const names = stringArray(objectBody(request.body).names, 'names');
    return call(() => service.replaceTags(ownerId(request), pathId(request, 'modelId'), names));
  });

  application.get('/api/v1/catalogue/tags', authenticated, async (request) =>
    call(() => service.listTags(ownerId(request))),
  );

  application.get('/api/v1/catalogue/collections', authenticated, async (request) =>
    call(() => service.listCollections(ownerId(request))),
  );

  application.post('/api/v1/catalogue/collections', authenticated, async (request, reply) => {
    const body = objectBody(request.body);
    const result = await call(() =>
      service.createCollection(
        ownerId(request),
        requiredString(body.name, 'name'),
        optionalString(body.description) ?? '',
      ),
    );
    return reply.status(201).send(result);
  });

  application.patch(
    '/api/v1/catalogue/collections/:collectionId',
    authenticated,
    async (request) => {
      const body = objectBody(request.body);
      if (body.name === undefined && body.description === undefined)
        invalid('At least one collection field is required');
      return call(() =>
        service.updateCollection(ownerId(request), pathId(request, 'collectionId'), {
          ...(body.name === undefined ? {} : { name: requiredString(body.name, 'name') }),
          ...(body.description === undefined
            ? {}
            : { description: requiredString(body.description, 'description', true) }),
        }),
      );
    },
  );

  application.delete(
    '/api/v1/catalogue/collections/:collectionId',
    authenticated,
    async (request, reply) => {
      await call(() => service.deleteCollection(ownerId(request), pathId(request, 'collectionId')));
      return reply.status(204).send();
    },
  );

  application.put(
    '/api/v1/catalogue/models/:modelId/collections',
    authenticated,
    async (request) => {
      const ids = stringArray(objectBody(request.body).collectionIds, 'collectionIds');
      return call(() =>
        service.replaceCollections(ownerId(request), pathId(request, 'modelId'), ids),
      );
    },
  );

  return { service };
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CatalogueNotFoundError)
      throw new HttpError(404, 'catalogue_not_found', error.message);
    if (error instanceof CatalogueConflictError)
      throw new HttpError(409, 'catalogue_conflict', error.message);
    if (error instanceof TypeError)
      throw new HttpError(400, 'catalogue_request_invalid', error.message);
    throw error;
  }
}

function createModelBody(value: unknown): CreateModelInput {
  const body = objectBody(value);
  const importSource = requiredString(body.importSource, 'importSource');
  if (importSource !== 'upload' && importSource !== 'yuki_export')
    invalid('importSource is invalid');
  return {
    ...(body.id === undefined ? {} : { id: requiredString(body.id, 'id') }),
    name: requiredString(body.name, 'name'),
    ...(body.description === undefined
      ? {}
      : { description: requiredString(body.description, 'description', true) }),
    importSource,
    ...(body.sourceUrl === undefined
      ? {}
      : { sourceUrl: nullableString(body.sourceUrl, 'sourceUrl') }),
    ...(body.creator === undefined ? {} : { creator: nullableString(body.creator, 'creator') }),
    ...(body.license === undefined ? {} : { license: nullableString(body.license, 'license') }),
    ...(body.favorite === undefined
      ? {}
      : { favorite: requiredBoolean(body.favorite, 'favorite') }),
    initialVersion: versionBody(body.initialVersion),
  };
}

function updateModelBody(value: unknown): UpdateModelInput {
  const body = objectBody(value);
  const result: UpdateModelInput = {
    ...(body.name === undefined ? {} : { name: requiredString(body.name, 'name') }),
    ...(body.description === undefined
      ? {}
      : { description: requiredString(body.description, 'description', true) }),
    ...(body.sourceUrl === undefined
      ? {}
      : { sourceUrl: nullableString(body.sourceUrl, 'sourceUrl') }),
    ...(body.creator === undefined ? {} : { creator: nullableString(body.creator, 'creator') }),
    ...(body.license === undefined ? {} : { license: nullableString(body.license, 'license') }),
    ...(body.favorite === undefined
      ? {}
      : { favorite: requiredBoolean(body.favorite, 'favorite') }),
    ...(body.expectedUpdatedAt === undefined
      ? {}
      : { expectedUpdatedAt: requiredDate(body.expectedUpdatedAt, 'expectedUpdatedAt') }),
  };
  if (Object.keys(result).length === 0) invalid('At least one model field is required');
  return result;
}

function versionBody(value: unknown): CatalogueVersionInput {
  const body = objectBody(value);
  const metadataSnapshot = objectBody(body.metadataSnapshot);
  if (!Array.isArray(body.assets)) invalid('assets must be an array');
  return {
    ...(body.id === undefined ? {} : { id: requiredString(body.id, 'id') }),
    label: requiredString(body.label, 'label'),
    ...(body.changeNote === undefined
      ? {}
      : { changeNote: nullableString(body.changeNote, 'changeNote') }),
    metadataSnapshot,
    assets: body.assets.map((value) => assetBody(value)),
  };
}

function assetBody(value: unknown) {
  const body = objectBody(value);
  const role = requiredString(body.role, 'role');
  const format = requiredString(body.format, 'format');
  const roles: readonly string[] = [
    'geometry',
    'gcode',
    'image',
    'document',
    'other',
    'original_archive',
  ];
  const formats: readonly string[] = [
    'stl',
    '3mf',
    'obj',
    'step',
    'gcode',
    'image',
    'document',
    'archive',
    'other',
  ];
  if (!roles.includes(role)) invalid('role is invalid');
  if (!formats.includes(format)) invalid('format is invalid');
  return {
    ...(body.id === undefined ? {} : { id: requiredString(body.id, 'id') }),
    storedObjectId: requiredString(body.storedObjectId, 'storedObjectId'),
    role: role as CatalogueAssetRole,
    format: format as CatalogueAssetFormat,
    originalFilename: requiredString(body.originalFilename, 'originalFilename'),
    detectedMimeType: requiredString(body.detectedMimeType, 'detectedMimeType'),
    byteSize: requiredNumber(body.byteSize, 'byteSize'),
    checksum: requiredString(body.checksum, 'checksum'),
  };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid('Request body must be an object');
  return value as Record<string, unknown>;
}

function pathId(request: FastifyRequest, name: string): string {
  const params = request.params;
  if (typeof params !== 'object' || params === null) invalid(`${name} is required`);
  return requiredString((params as Record<string, unknown>)[name], name);
}

function requiredString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0))
    invalid(`${field} must be a string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value, 'value', true);
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : requiredString(value, field, true);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') invalid(`${field} must be a number`);
  return value;
}

function requiredDate(value: unknown, field: string): Date {
  const date = new Date(requiredString(value, field));
  if (!Number.isFinite(date.getTime())) invalid(`${field} must be an ISO date`);
  return date;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array`);
  return value.map((entry) => requiredString(entry, field));
}

function invalid(message: string): never {
  throw new HttpError(400, 'catalogue_request_invalid', message);
}
