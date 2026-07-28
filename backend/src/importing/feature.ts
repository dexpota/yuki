import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OwnerContext } from '../identity/index.js';
import { HttpError } from '../platform/http/index.js';
import type { PersistedImportFile } from './processing/index.js';
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
  readonly processing?: {
    readonly files: (sessionId: string) => Promise<readonly PersistedImportFile[]>;
    readonly keepExactDuplicates: (sessionId: string, fileIds: readonly string[]) => Promise<void>;
  };
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
      const filename = uploadMetadataHeader(request, 'x-yuki-filename');
      const modelName = uploadMetadataHeader(request, 'x-yuki-model-name');
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

  application.post(
    '/api/v1/catalogue/models/:modelId/versions/import',
    { preHandler: options.identity.requireOwner },
    async (request, reply) => {
      const owner = options.identity.ownerForRequest(request).owner;
      const body = request.body;
      if (!isAsyncIterable(body))
        throw new HttpError(400, 'upload_body_required', 'A binary upload body is required');
      try {
        const idempotencyKey = optionalHeader(request, 'idempotency-key');
        const session = await options.service.receive({
          ownerId: owner.id,
          targetModelId: pathModelId(request),
          versionLabel: uploadMetadataHeader(request, 'x-yuki-version-label'),
          changeNote: optionalUploadMetadataHeader(request, 'x-yuki-change-note') ?? null,
          originalFilename: uploadMetadataHeader(request, 'x-yuki-filename'),
          claimedMimeType: contentType(request),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          source: body,
        });
        reply.status(202);
        return response(session, optionalContentLength(request));
      } catch (error) {
        if (hasCause(error, UploadLimitExceededError))
          throw new HttpError(413, 'upload_too_large', 'Upload exceeds the configured byte limit');
        if (error instanceof ImportSessionNotFoundError)
          throw new HttpError(404, 'catalogue_not_found', 'Target model does not exist');
        if (error instanceof TypeError) throw new HttpError(400, 'upload_invalid', error.message);
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
        const session = await options.service.get(owner.id, sessionId);
        const files = options.processing ? await options.processing.files(sessionId) : undefined;
        return response(session, undefined, files);
      } catch (error) {
        if (error instanceof ImportSessionNotFoundError) {
          throw new HttpError(404, 'import_not_found', 'Import session does not exist');
        }
        throw error;
      }
    },
  );

  if (options.processing) {
    application.post(
      '/api/v1/imports/:sessionId/duplicate-decisions',
      { preHandler: options.identity.requireOwner },
      async (request, reply) => {
        const owner = options.identity.ownerForRequest(request).owner;
        const sessionId = pathSessionId(request);
        try {
          await options.service.get(owner.id, sessionId);
          const fileIds = duplicateKeepFileIds(request.body);
          await options.processing?.keepExactDuplicates(sessionId, fileIds);
          reply.status(202);
          return { sessionId, decision: 'keep', fileIds };
        } catch (error) {
          if (error instanceof ImportSessionNotFoundError) {
            throw new HttpError(404, 'import_not_found', 'Import session does not exist');
          }
          if (error instanceof TypeError) {
            throw new HttpError(409, 'duplicate_decision_invalid', error.message);
          }
          throw error;
        }
      },
    );
  }
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'upload_header_required', `${name} header is required`);
  }
  return value;
}

function uploadMetadataHeader(request: FastifyRequest, name: string): string {
  const value = requiredHeader(request, name);
  if (optionalHeader(request, 'x-yuki-value-encoding') !== 'percent') return value;
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'upload_header_invalid', `${name} header is invalid`);
  }
}

function optionalHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalUploadMetadataHeader(request: FastifyRequest, name: string): string | undefined {
  const value = optionalHeader(request, name);
  if (value === undefined) return undefined;
  if (optionalHeader(request, 'x-yuki-value-encoding') !== 'percent') return value;
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'upload_header_invalid', `${name} header is invalid`);
  }
}

function contentType(request: FastifyRequest): string {
  const claimed = optionalHeader(request, 'x-yuki-claimed-mime-type');
  if (claimed) return claimed.slice(0, 255);
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

function pathModelId(request: FastifyRequest): string {
  const value = (request.params as { modelId?: unknown }).modelId;
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value))
    throw new HttpError(400, 'catalogue_id_invalid', 'Model ID is invalid');
  return value;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function response(
  session: ImportSessionView,
  declaredLength?: number,
  files?: readonly PersistedImportFile[],
) {
  return {
    id: session.id,
    state: session.state,
    originalFilename: session.originalFilename,
    modelName: session.modelName,
    purpose: session.purpose,
    targetModelId: session.targetModelId,
    versionLabel: session.versionLabel,
    changeNote: session.changeNote,
    uploadedBytes: session.uploadedBytes,
    ...(declaredLength !== undefined ? { declaredLength } : {}),
    checksum: session.checksum,
    progress: session.progress,
    modelId: session.modelId,
    error: session.error,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    completedAt: session.completedAt?.toISOString() ?? null,
    ...(files ? { files: files.map(fileResponse) } : {}),
  };
}

function fileResponse(file: PersistedImportFile) {
  return {
    id: file.id,
    fileKey: file.fileKey,
    originalFilename: file.originalFilename,
    isOriginal: file.isOriginal,
    status: file.status,
    role: file.role,
    format: file.format,
    detectedMimeType: file.detectedMimeType,
    byteSize: file.byteSize,
    checksum: file.checksum,
    detection: file.detection,
    warnings: file.warnings,
    duplicateAssetIds: file.duplicateAssetIds,
    duplicateDecision: file.duplicateDecision,
    error: file.error,
  };
}

function duplicateKeepFileIds(body: unknown): readonly string[] {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('decision' in body) ||
    body.decision !== 'keep' ||
    !('fileIds' in body) ||
    !Array.isArray(body.fileIds) ||
    body.fileIds.length < 1 ||
    body.fileIds.length > 100 ||
    body.fileIds.some((id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id))
  ) {
    throw new HttpError(
      400,
      'duplicate_decision_invalid',
      'A keep decision with one or more import file IDs is required',
    );
  }
  return body.fileIds;
}

function hasCause(error: unknown, kind: new (message?: string) => Error): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (Object.prototype.isPrototypeOf.call(kind.prototype, current)) return true;
    current = current.cause;
  }
  return false;
}
