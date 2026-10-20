import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { OwnerContext } from '../../identity/index.js';
import { HttpError } from '../../platform/http/index.js';
import {
  PrintPlanConflictError,
  PrintPlanEntryNotFoundError,
  type PrintPlanningService,
} from './service.js';

export interface PrintPlanningIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export function registerPrintPlanningFeature(
  application: FastifyInstance,
  options: {
    readonly identity: PrintPlanningIdentityBoundary;
    readonly service: PrintPlanningService;
  },
): void {
  const auth = { preHandler: options.identity.requireOwner };
  const ownerId = (request: FastifyRequest) => options.identity.ownerForRequest(request).owner.id;

  application.get('/api/v1/printing/plan', auth, async (request) => ({
    entries: await options.service.list(ownerId(request)),
  }));
  application.post('/api/v1/printing/plan', auth, async (request, reply) => {
    const body = objectBody(request.body);
    const entry = await call(() =>
      options.service.create(
        ownerId(request),
        requiredString(body.modelId, 'modelId'),
        requiredString(body.versionId, 'versionId'),
      ),
    );
    return reply.status(201).send(entry);
  });
  application.put('/api/v1/printing/plan/order', auth, async (request) => {
    const body = objectBody(request.body);
    if (!Array.isArray(body.entryIds) || !body.entryIds.every((id) => typeof id === 'string'))
      throw new HttpError(400, 'print_plan_request_invalid', 'entryIds must be a string array');
    return {
      entries: await call(() =>
        options.service.reorder(ownerId(request), body.entryIds as string[]),
      ),
    };
  });
  application.delete('/api/v1/printing/plan/:entryId', auth, async (request, reply) => {
    await call(() => options.service.remove(ownerId(request), pathId(request, 'entryId')));
    return reply.status(204).send();
  });
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PrintPlanEntryNotFoundError)
      throw new HttpError(404, 'print_plan_not_found', error.message);
    if (error instanceof PrintPlanConflictError)
      throw new HttpError(409, 'print_plan_conflict', error.message);
    throw error;
  }
}
function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'print_plan_request_invalid', 'Request body must be an object');
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new HttpError(400, 'print_plan_request_invalid', `${name} is required`);
  return value;
}
function pathId(request: FastifyRequest, name: string): string {
  return requiredString((request.params as Record<string, unknown>)[name], name);
}
