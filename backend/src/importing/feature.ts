import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OwnerContext } from '../identity/index.js';
import { HttpError } from '../platform/http/index.js';
import {
  ImportSessionNotFoundError,
  type ImportSessionView,
  type LocalImportService,
  UploadLimitExceededError,
} from './service.js';

export interface ImportIdentityContract {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export interface LocalImportFeatureOptions {
  readonly service: LocalImportService;
  readonly identity: ImportIdentityContract;
}

/** Registers transport only; storage, database and worker composition stay in the roots. */
export function registerLocalImportFeature(
  application: FastifyInstance,
  options: LocalImportFeatureOptions,
): void {
  if (!application.hasContentTypeParser('application/octet-stream')) {
    application.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
      done(null, payload),
    );
  }

  application.post(
    '/api/v1/imports/local',
    { preHandler: options.identity.requireOwner },
    async (request, reply) => {
      const owner = options.identity.ownerForRequest(request).owner;
      const filename = requiredHeader(request, 'x-yuki-filename');
      const modelName = requiredHeader(request, 'x-yuki-model-name');
      const idempotencyKey = optionalHeader(request, 'idempotency-key');
      const claimedMimeType = contentType(request);
      const declaredLength = optionalContentLength(request);
      const body = request.body;
      if (!isAsyncIterable(body)) {
        throw new HttpError(400, 'upload_body_required', 'A binary upload body is required');
      }
      try {
        const session = await options.service.receive({
          ownerId: owner.id,
          originalFilename: filename,
          modelName,
          claimedMimeType,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          source: body,
        });
        reply.status(202);
        return response(session, declaredLength);
      } catch (error) {
        if (hasCause(error, UploadLimitExceededError)) {
          throw new HttpError(413, 'upload_too_large', 'Upload exceeds the configured byte limit');
        }
        if (error instanceof TypeError) {
          throw new HttpError(400, 'upload_invalid', error.message);
        }
        throw error;
      }
    },
  );

  application.get(
    '/api/v1/imports/:sessionId',
    { preHandler: options.identity.requireOwner },
    async (request) => {
      const owner = options.identity.ownerForRequest(request).owner;
      const sessionId = pathSessionId(request);
      try {
        return response(await options.service.get(owner.id, sessionId));
      } catch (error) {
        if (error instanceof ImportSessionNotFoundError) {
          throw new HttpError(404, 'import_not_found', 'Import session does not exist');
        }
        throw error;
      }
    },
  );
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'upload_header_required', `${name} header is required`);
  }
  return value;
}

function optionalHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function contentType(request: FastifyRequest): string {
  const value = request.headers['content-type'];
  return typeof value === 'string'
    ? value.split(';', 1)[0]?.trim() || 'application/octet-stream'
    : 'application/octet-stream';
}

function optionalContentLength(request: FastifyRequest): number | undefined {
  const value = request.headers['content-length'];
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function pathSessionId(request: FastifyRequest): string {
  const parameters = request.params as { sessionId?: unknown };
  if (typeof parameters.sessionId !== 'string' || !parameters.sessionId) {
    throw new HttpError(400, 'import_id_invalid', 'Import session ID is invalid');
  }
  return parameters.sessionId;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function response(session: ImportSessionView, declaredLength?: number) {
  return {
    id: session.id,
    state: session.state,
    originalFilename: session.originalFilename,
    modelName: session.modelName,
    uploadedBytes: session.uploadedBytes,
    ...(declaredLength !== undefined ? { declaredLength } : {}),
    checksum: session.checksum,
    progress: session.progress,
    modelId: session.modelId,
    error: session.error,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    completedAt: session.completedAt?.toISOString() ?? null,
  };
}

function hasCause(error: unknown, kind: new (message?: string) => Error): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (Object.prototype.isPrototypeOf.call(kind.prototype, current)) return true;
    current = current.cause;
  }
  return false;
}
