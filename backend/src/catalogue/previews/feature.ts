import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OwnerContext } from '../../identity/index.js';
import { HttpError } from '../../platform/http/index.js';
import type { ArtifactView } from './contracts.js';
import {
  CataloguePreviewNotFoundError,
  type CataloguePreviewOperations,
  CataloguePreviewUnavailableError,
} from './operations.js';

export interface CataloguePreviewIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export function registerCataloguePreviewFeature(
  application: FastifyInstance,
  options: {
    readonly identity: CataloguePreviewIdentityBoundary;
    readonly operations: CataloguePreviewOperations;
  },
): void {
  const authenticated = { preHandler: options.identity.requireOwner };
  const ownerId = (request: FastifyRequest) => options.identity.ownerForRequest(request).owner.id;

  application.post(
    '/api/v1/catalogue/assets/:assetId/previews',
    authenticated,
    async (request, reply) => {
      try {
        const artifacts = await options.operations.request(
          ownerId(request),
          pathId(request, 'assetId'),
        );
        return reply.status(202).send({ artifacts: artifacts.map(response) });
      } catch (error) {
        throw translated(error);
      }
    },
  );

  application.get('/api/v1/catalogue/assets/:assetId/previews', authenticated, async (request) => {
    try {
      const artifacts = await options.operations.list(ownerId(request), pathId(request, 'assetId'));
      return { artifacts: artifacts.map(response) };
    } catch (error) {
      throw translated(error);
    }
  });

  application.get(
    '/api/v1/catalogue/previews/:artifactId/download',
    authenticated,
    async (request, reply) => {
      try {
        const artifact = await options.operations.download(
          ownerId(request),
          pathId(request, 'artifactId'),
        );
        return reply
          .type(artifact.mimeType)
          .header('Content-Length', String(artifact.byteSize))
          .header('Content-Disposition', `inline; filename="${artifact.filename}"`)
          .header('Cache-Control', 'private, max-age=31536000, immutable')
          .send(artifact.stream);
      } catch (error) {
        throw translated(error);
      }
    },
  );
}

function response(artifact: ArtifactView) {
  return {
    id: artifact.id,
    sourceAssetId: artifact.sourceAssetId,
    kind: artifact.kind,
    status: artifact.status,
    mimeType: artifact.mimeType,
    byteSize: artifact.byteSize,
    dimensions: artifact.dimensions,
    summary: artifact.summary,
    failure: artifact.failure,
    attempt: artifact.attempt,
    downloadUrl:
      artifact.status === 'ready'
        ? `/api/v1/catalogue/previews/${encodeURIComponent(artifact.id)}/download`
        : null,
  };
}

function translated(error: unknown): Error {
  if (error instanceof CataloguePreviewNotFoundError)
    return new HttpError(404, 'catalogue_preview_not_found', error.message);
  if (error instanceof CataloguePreviewUnavailableError)
    return new HttpError(409, 'catalogue_preview_unavailable', error.message);
  return error instanceof Error ? error : new Error('Catalogue preview operation failed.');
}

function pathId(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !value)
    throw new HttpError(400, 'catalogue_preview_id_invalid', `${name} is invalid`);
  return value;
}
