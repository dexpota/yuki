import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OwnerContext } from '../../identity/index.js';
import { HttpError } from '../../platform/http/index.js';
import type { PrintStartService } from './service.js';
import { PrintStartConflictError, PrintStartNotFoundError } from './service.js';

export interface PrintStartIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export function registerPrintStartFeature(
  application: FastifyInstance,
  options: { readonly identity: PrintStartIdentityBoundary; readonly service: PrintStartService },
): void {
  const authenticated = { preHandler: options.identity.requireOwner };
  const ownerId = (request: FastifyRequest) => options.identity.ownerForRequest(request).owner.id;

  application.post(
    '/api/v1/printing/print-jobs/:jobId/start-confirmations',
    authenticated,
    async (request, reply) => {
      const challenge = await call(() =>
        options.service.issue(ownerId(request), pathId(request, 'jobId')),
      );
      return reply.status(201).send({
        token: challenge.token,
        expiresAt: challenge.expiresAt.toISOString(),
        printer: challenge.printer,
        file: challenge.file,
        compatibilityStatus: challenge.compatibilityStatus,
        warnings: challenge.warnings,
        safetyNotice: challenge.safetyNotice,
      });
    },
  );

  application.post(
    '/api/v1/printing/print-jobs/:jobId/start',
    authenticated,
    async (request, reply) => {
      const body = objectBody(request.body);
      const result = await call(() =>
        options.service.accept(
          ownerId(request),
          pathId(request, 'jobId'),
          requiredString(body.confirmationToken, 'confirmationToken'),
          idempotencyKey(request),
        ),
      );
      return reply.status(202).send(result);
    },
  );
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PrintStartNotFoundError)
      throw new HttpError(404, 'print_start_not_found', error.message);
    if (error instanceof PrintStartConflictError)
      throw new HttpError(409, 'print_start_conflict', error.message);
    if (error instanceof TypeError)
      throw new HttpError(400, 'print_start_request_invalid', error.message);
    throw error;
  }
}

function pathId(request: FastifyRequest, name: string): string {
  return requiredString((request.params as Record<string, unknown>)[name], name);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'print_start_request_invalid', 'Request body must be an object');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new HttpError(400, 'print_start_request_invalid', `${name} is required`);
  return value;
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
