import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OwnerContext } from '../../identity/index.js';
import { HttpError } from '../../platform/http/index.js';
import {
  CataloguePortabilityOperationNotFoundError,
  type CataloguePortabilityOperations,
  type CataloguePortabilityOperationView,
  CataloguePortabilityUploadTooLargeError,
} from './operations.js';

export interface CataloguePortabilityIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export function registerCataloguePortabilityFeature(
  application: FastifyInstance,
  options: {
    readonly operations: CataloguePortabilityOperations;
    readonly identity: CataloguePortabilityIdentityBoundary;
  },
): void {
  const mediaType = 'application/vnd.yuki.model+zip';
  if (!application.hasContentTypeParser(mediaType))
    application.addContentTypeParser(mediaType, (_request, payload, done) => done(null, payload));
  const authenticated = { preHandler: options.identity.requireOwner };
  const ownerId = (request: FastifyRequest) => options.identity.ownerForRequest(request).owner.id;

  application.post(
    '/api/v1/catalogue/models/:modelId/exports',
    authenticated,
    async (request, reply) => {
      try {
        const operation = await options.operations.enqueueExport(
          ownerId(request),
          pathId(request, 'modelId'),
          idempotencyKey(request),
        );
        return reply.status(202).send(response(operation));
      } catch (error) {
        throw translated(error);
      }
    },
  );

  application.post('/api/v1/catalogue/imports', authenticated, async (request, reply) => {
    if (!isAsyncIterable(request.body))
      throw new HttpError(400, 'portable_package_required', 'A Yuki export package is required');
    try {
      const operation = await options.operations.receiveImport(
        ownerId(request),
        request.body,
        idempotencyKey(request),
      );
      return reply.status(202).send(response(operation));
    } catch (error) {
      throw translated(error);
    }
  });

  application.get('/api/v1/catalogue/portability/:operationId', authenticated, async (request) => {
    try {
      return response(
        await options.operations.get(ownerId(request), pathId(request, 'operationId')),
      );
    } catch (error) {
      throw translated(error);
    }
  });

  application.get(
    '/api/v1/catalogue/portability/:operationId/download',
    authenticated,
    async (request, reply) => {
      try {
        const download = await options.operations.download(
          ownerId(request),
          pathId(request, 'operationId'),
        );
        return reply
          .type('application/vnd.yuki.model+zip')
          .header('Content-Disposition', `attachment; filename="${download.filename}"`)
          .send(download.stream);
      } catch (error) {
        throw translated(error);
      }
    },
  );
}

function response(operation: CataloguePortabilityOperationView) {
  return {
    id: operation.id,
    kind: operation.kind,
    state: operation.state,
    sourceModelId: operation.sourceModelId,
    importedModelId: operation.importedModelId,
    progress: operation.progress,
    downloadReady: operation.downloadReady,
    error: operation.error,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null,
  };
}

function translated(error: unknown): Error {
  if (error instanceof CataloguePortabilityOperationNotFoundError)
    return new HttpError(404, 'portability_not_found', error.message);
  if (error instanceof CataloguePortabilityUploadTooLargeError)
    return new HttpError(413, 'portable_package_too_large', 'The package exceeds the upload limit');
  return error instanceof Error ? error : new Error('Catalogue portability operation failed');
}
function pathId(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !value)
    throw new HttpError(400, 'portability_id_invalid', `${name} is invalid`);
  return value;
}
function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' && value.trim() ? value.slice(0, 200) : undefined;
}
function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}
