import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OwnerContext } from '../../identity/index.js';
import { HttpError } from '../../platform/http/index.js';
import type { PrintAttemptView, PrintOutcome } from './contracts.js';
import {
  PrintHistoryConflictError,
  PrintHistoryNotFoundError,
  type PrintHistoryService,
} from './service.js';

export interface PrintHistoryIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export function registerPrintHistoryFeature(
  application: FastifyInstance,
  options: {
    readonly identity: PrintHistoryIdentityBoundary;
    readonly service: PrintHistoryService;
  },
): void {
  for (const type of ['application/octet-stream', 'image/jpeg', 'image/png', 'image/webp'])
    if (!application.hasContentTypeParser(type))
      application.addContentTypeParser(type, (_request, payload, done) => done(null, payload));
  const authenticated = { preHandler: options.identity.requireOwner };
  const ownerId = (request: FastifyRequest) => options.identity.ownerForRequest(request).owner.id;

  application.get('/api/v1/printing/print-attempts', authenticated, async (request) => {
    const query = objectValue(request.query);
    const modelId = optionalString(query.modelId);
    const printerId = optionalString(query.printerId);
    return {
      attempts: (
        await call(() =>
          options.service.list({
            ownerId: ownerId(request),
            ...(modelId ? { modelId } : {}),
            ...(printerId ? { printerId } : {}),
            ...(query.limit === undefined ? {} : { limit: integer(query.limit, 'limit') }),
          }),
        )
      ).map(response),
    };
  });

  application.get('/api/v1/printing/print-attempts/:attemptId', authenticated, async (request) =>
    response(await call(() => options.service.get(ownerId(request), pathId(request, 'attemptId')))),
  );

  application.get(
    '/api/v1/printing/print-attempts/:attemptId/audit',
    authenticated,
    async (request) => {
      const audit = await call(() =>
        options.service.audit(ownerId(request), pathId(request, 'attemptId')),
      );
      return {
        events: audit.events.map((event) => ({
          id: event.id,
          kind: event.kind,
          facts: event.facts,
          recordedAt: event.recorded_at.toISOString(),
        })),
        outcomeCorrections: audit.outcomeCorrections.map((correction) => ({
          id: correction.id,
          previousOutcome: correction.previous_outcome,
          outcome: correction.outcome,
          reason: correction.reason,
          correctedAt: correction.corrected_at.toISOString(),
        })),
        noteRevisions: audit.noteRevisions.map((revision) => ({
          id: revision.id,
          notes: revision.notes,
          createdAt: revision.created_at.toISOString(),
        })),
      };
    },
  );

  application.post('/api/v1/printing/print-attempts', authenticated, async (request, reply) => {
    const body = objectBody(request.body);
    const requestKey = idempotencyKey(request);
    const result = await call(() =>
      options.service.createManual({
        ownerId: ownerId(request),
        modelId: requiredString(body.modelId, 'modelId'),
        modelVersionId: requiredString(body.modelVersionId, 'modelVersionId'),
        assetId: requiredString(body.assetId, 'assetId'),
        printerId: requiredString(body.printerId, 'printerId'),
        source: source(body.source),
        startedAt: date(body.startedAt, 'startedAt'),
        completedAt: date(body.completedAt, 'completedAt'),
        outcome: outcome(body.outcome),
        ...(body.notes === undefined ? {} : { notes: stringValue(body.notes, 'notes') }),
        ...(requestKey ? { idempotencyKey: requestKey } : {}),
      }),
    );
    return reply.status(201).send(response(result));
  });

  application.post(
    '/api/v1/printing/print-attempts/:attemptId/outcome-corrections',
    authenticated,
    async (request, reply) => {
      const body = objectBody(request.body);
      const result = await call(() =>
        options.service.correctOutcome(
          ownerId(request),
          pathId(request, 'attemptId'),
          outcome(body.outcome),
          requiredString(body.reason, 'reason'),
          idempotencyKey(request),
        ),
      );
      return reply.status(201).send(response(result));
    },
  );

  application.put(
    '/api/v1/printing/print-attempts/:attemptId/notes',
    authenticated,
    async (request) => {
      const body = objectBody(request.body);
      return response(
        await call(() =>
          options.service.updateNotes(
            ownerId(request),
            pathId(request, 'attemptId'),
            stringValue(body.notes, 'notes'),
            idempotencyKey(request),
          ),
        ),
      );
    },
  );

  application.post(
    '/api/v1/printing/print-attempts/:attemptId/photos',
    authenticated,
    async (request, reply) => {
      if (!isAsyncIterable(request.body))
        throw new HttpError(400, 'print_photo_body_required', 'A binary photo body is required.');
      const requestKey = idempotencyKey(request);
      const declaredMimeType = contentType(request);
      const photo = await call(() =>
        options.service.addPhoto({
          ownerId: ownerId(request),
          attemptId: pathId(request, 'attemptId'),
          filename: requiredHeader(request, 'x-yuki-filename'),
          ...(declaredMimeType ? { declaredMimeType } : {}),
          bytes: request.body as AsyncIterable<Uint8Array>,
          ...(requestKey ? { idempotencyKey: requestKey } : {}),
        }),
      );
      return reply.status(201).send(photoResponse(pathId(request, 'attemptId'), photo));
    },
  );

  application.get(
    '/api/v1/printing/print-attempts/:attemptId/photos/:photoId',
    authenticated,
    async (request, reply) => {
      const photo = await call(() =>
        options.service.photoSource(
          ownerId(request),
          pathId(request, 'attemptId'),
          pathId(request, 'photoId'),
        ),
      );
      return reply
        .type(photo.mimeType)
        .header('Content-Length', String(photo.byteSize))
        .header(
          'Content-Disposition',
          `inline; filename="${photo.filename.replaceAll(/[\r\n"]/g, '_')}"`,
        )
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .send(photo.stream);
    },
  );
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PrintHistoryNotFoundError)
      throw new HttpError(404, 'print_history_not_found', error.message);
    if (error instanceof PrintHistoryConflictError)
      throw new HttpError(409, 'print_history_conflict', error.message);
    if (error instanceof TypeError)
      throw new HttpError(400, 'print_history_request_invalid', error.message);
    throw error;
  }
}

function response(attempt: PrintAttemptView) {
  return {
    id: attempt.id,
    source: attempt.source,
    queueEntryId: attempt.queueEntryId,
    printerId: attempt.printerId,
    modelId: attempt.modelId,
    modelVersionId: attempt.modelVersionId,
    assetId: attempt.assetId,
    state: attempt.state,
    outcome: attempt.outcome,
    notes: attempt.notes,
    statistics: attempt.statistics,
    printerSnapshot: attempt.printerSnapshot,
    modelSnapshot: attempt.modelSnapshot,
    assetSnapshot: attempt.assetSnapshot,
    compatibilitySnapshot: attempt.compatibilitySnapshot,
    overrideJustification: attempt.overrideJustification,
    startedAt: attempt.startedAt?.toISOString() ?? null,
    completedAt: attempt.completedAt?.toISOString() ?? null,
    createdAt: attempt.createdAt.toISOString(),
    updatedAt: attempt.updatedAt.toISOString(),
    version: attempt.version,
    photos: attempt.photos.map((photo) => photoResponse(attempt.id, photo)),
  };
}

function photoResponse(attemptId: string, photo: PrintAttemptView['photos'][number]) {
  return {
    id: photo.id,
    filename: photo.filename,
    mimeType: photo.mimeType,
    byteSize: photo.byteSize,
    checksum: photo.checksum,
    createdAt: photo.createdAt.toISOString(),
    downloadUrl: `/api/v1/printing/print-attempts/${encodeURIComponent(attemptId)}/photos/${encodeURIComponent(photo.id)}`,
  };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'print_history_request_invalid', 'Request body must be an object.');
  return value as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pathId(request: FastifyRequest, name: string): string {
  return requiredString((request.params as Record<string, unknown>)[name], name);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new HttpError(400, 'print_history_request_invalid', `${name} is required.`);
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string')
    throw new HttpError(400, 'print_history_request_invalid', `${name} must be a string.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function outcome(value: unknown): PrintOutcome {
  if (!['successful', 'failed', 'cancelled', 'unknown'].includes(String(value)))
    throw new HttpError(400, 'print_history_request_invalid', 'outcome is invalid.');
  return value as PrintOutcome;
}

function source(value: unknown): 'manual' | 'external' {
  if (value !== 'manual' && value !== 'external')
    throw new HttpError(400, 'print_history_request_invalid', 'source is invalid.');
  return value;
}

function date(value: unknown, name: string): Date {
  if (typeof value !== 'string') invalidDate(name);
  const result = new Date(value as string);
  if (!Number.isFinite(result.getTime())) invalidDate(name);
  return result;
}

function invalidDate(name: string): never {
  throw new HttpError(400, 'print_history_request_invalid', `${name} must be an ISO timestamp.`);
}

function integer(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new HttpError(400, 'print_history_request_invalid', `${name} must be an integer.`);
  return result;
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  return optionalString(request.headers['idempotency-key']);
}

function requiredHeader(request: FastifyRequest, name: string): string {
  return requiredString(request.headers[name], name);
}

function contentType(request: FastifyRequest): string | undefined {
  return request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function'
  );
}
