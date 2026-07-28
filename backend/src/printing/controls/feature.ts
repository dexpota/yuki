import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OwnerContext } from '../../identity/index.js';
import { HttpError } from '../../platform/http/index.js';
import type { PrinterControlRequest } from './contracts.js';
import {
  PrinterControlConflictError,
  PrinterControlNotFoundError,
  type PrinterControlService,
} from './service.js';

export interface PrinterControlIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export function registerPrinterControlFeature(
  application: FastifyInstance,
  options: {
    readonly identity: PrinterControlIdentityBoundary;
    readonly service: PrinterControlService;
  },
): void {
  const authenticated = { preHandler: options.identity.requireOwner };
  const ownerId = (request: FastifyRequest) => options.identity.ownerForRequest(request).owner.id;

  application.post(
    '/api/v1/printing/printers/:printerId/control-confirmations',
    authenticated,
    async (request, reply) => {
      const body = objectBody(request.body);
      const challenge = await call(() =>
        options.service.issue(
          ownerId(request),
          pathId(request, 'printerId'),
          body as unknown as PrinterControlRequest,
        ),
      );
      return reply.status(201).send({
        token: challenge.token,
        expiresAt: challenge.expiresAt.toISOString(),
        action: challenge.action,
        printer: challenge.printer,
        queueEntryId: challenge.queueEntryId,
        parameters: challenge.parameters,
        safetyNotice: challenge.safetyNotice,
      });
    },
  );

  application.post(
    '/api/v1/printing/printers/:printerId/controls',
    authenticated,
    async (request, reply) => {
      const body = objectBody(request.body);
      const result = await call(() =>
        options.service.accept(
          ownerId(request),
          pathId(request, 'printerId'),
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
    if (error instanceof PrinterControlNotFoundError)
      throw new HttpError(404, 'printer_control_not_found', error.message);
    if (error instanceof PrinterControlConflictError)
      throw new HttpError(409, 'printer_control_conflict', error.message);
    if (error instanceof TypeError)
      throw new HttpError(400, 'printer_control_request_invalid', error.message);
    throw error;
  }
}

function pathId(request: FastifyRequest, name: string): string {
  return requiredString((request.params as Record<string, unknown>)[name], name);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'printer_control_request_invalid', 'Request body must be an object');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new HttpError(400, 'printer_control_request_invalid', `${name} is required`);
  return value;
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
