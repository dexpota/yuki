import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OwnerContext } from '../../identity/index.js';
import { HttpError } from '../../platform/http/index.js';
import type { QueueEntryView } from './contracts.js';
import { QueueConflictError, QueueEntryNotFoundError, type QueueService } from './service.js';

export interface QueueIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export function registerQueueFeature(
  application: FastifyInstance,
  options: { readonly identity: QueueIdentityBoundary; readonly service: QueueService },
): void {
  const authenticated = { preHandler: options.identity.requireOwner };
  const ownerId = (request: FastifyRequest) => options.identity.ownerForRequest(request).owner.id;

  application.get('/api/v1/printing/printers/:printerId/queue', authenticated, async (request) => ({
    entries: (
      await call(() => options.service.list(ownerId(request), pathId(request, 'printerId')))
    ).map(response),
  }));

  application.post(
    '/api/v1/printing/printers/:printerId/queue',
    authenticated,
    async (request, reply) => {
      const body = objectBody(request.body);
      const requestKey = idempotencyKey(request);
      const entry = await call(() =>
        options.service.request({
          ownerId: ownerId(request),
          printerId: pathId(request, 'printerId'),
          assetId: requiredString(body.assetId, 'assetId'),
          ...(body.overrideJustification === undefined
            ? {}
            : {
                overrideJustification: requiredString(
                  body.overrideJustification,
                  'overrideJustification',
                ),
              }),
          ...(requestKey ? { idempotencyKey: requestKey } : {}),
        }),
      );
      return reply.status(202).send(response(entry));
    },
  );

  application.put(
    '/api/v1/printing/printers/:printerId/queue/order',
    authenticated,
    async (request) => {
      const body = objectBody(request.body);
      if (!Array.isArray(body.entryIds) || !body.entryIds.every((id) => typeof id === 'string'))
        throw new HttpError(400, 'queue_request_invalid', 'entryIds must be a string array');
      return {
        entries: (
          await call(() =>
            options.service.reorder(
              ownerId(request),
              pathId(request, 'printerId'),
              body.entryIds as string[],
            ),
          )
        ).map(response),
      };
    },
  );

  application.post(
    '/api/v1/printing/printers/:printerId/queue/:entryId/override',
    authenticated,
    async (request) => {
      const body = objectBody(request.body);
      return response(
        await call(() =>
          options.service.override(
            ownerId(request),
            pathId(request, 'printerId'),
            pathId(request, 'entryId'),
            requiredString(body.justification, 'justification'),
          ),
        ),
      );
    },
  );

  application.delete(
    '/api/v1/printing/printers/:printerId/queue/:entryId',
    authenticated,
    async (request, reply) => {
      await call(() =>
        options.service.remove(
          ownerId(request),
          pathId(request, 'printerId'),
          pathId(request, 'entryId'),
        ),
      );
      return reply.status(204).send();
    },
  );
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof QueueEntryNotFoundError)
      throw new HttpError(404, 'queue_not_found', error.message);
    if (error instanceof QueueConflictError)
      throw new HttpError(409, 'queue_conflict', error.message);
    if (error instanceof TypeError)
      throw new HttpError(400, 'queue_request_invalid', error.message);
    throw error;
  }
}

function response(entry: QueueEntryView) {
  return {
    id: entry.id,
    printerId: entry.printerId,
    assetId: entry.assetId,
    state: entry.state,
    position: entry.position,
    compatibilityStatus: entry.compatibilityStatus,
    compatibilitySnapshot: entry.compatibilitySnapshot,
    overrideJustification: entry.overrideJustification,
    error: entry.error,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    version: entry.version,
  };
}

function pathId(request: FastifyRequest, name: string): string {
  return requiredString((request.params as Record<string, unknown>)[name], name);
}
function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'queue_request_invalid', 'Request body must be an object');
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new HttpError(400, 'queue_request_invalid', `${name} is required`);
  return value;
}
function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
