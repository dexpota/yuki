import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OwnerContext } from '../../identity/index.js';
import { HttpError } from '../../platform/http/index.js';
import { MonitoredPrinterNotFoundError, type PrinterMonitoringService } from './service.js';

export interface PrinterMonitoringIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export interface PrinterMonitoringFeatureOptions {
  readonly identity: PrinterMonitoringIdentityBoundary;
  readonly service: PrinterMonitoringService;
}

export function registerPrinterMonitoringFeature(
  application: FastifyInstance,
  options: PrinterMonitoringFeatureOptions,
): void {
  const authenticated = { preHandler: options.identity.requireOwner };
  const ownerId = (request: FastifyRequest) => options.identity.ownerForRequest(request).owner.id;
  application.get(
    '/api/v1/printing/printers/:printerId/monitoring',
    authenticated,
    async (request) =>
      mapNotFound(async () => options.service.get(ownerId(request), printerIdFrom(request.params))),
  );
  application.get(
    '/api/v1/printing/printers/:printerId/observations',
    authenticated,
    async (request) =>
      mapNotFound(async () =>
        options.service.history(
          ownerId(request),
          printerIdFrom(request.params),
          historyLimit(request.query),
        ),
      ),
  );
}

async function mapNotFound<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MonitoredPrinterNotFoundError)
      throw new HttpError(404, 'printer_not_found', error.message);
    throw error;
  }
}

function printerIdFrom(value: unknown): string {
  if (!isObject(value) || typeof value.printerId !== 'string' || !value.printerId.trim())
    throw new HttpError(400, 'printer_request_invalid', 'printerId is required');
  return value.printerId;
}

function historyLimit(value: unknown): number {
  if (!isObject(value) || value.limit === undefined) return 50;
  const result = Number(value.limit);
  if (!Number.isSafeInteger(result) || result < 1 || result > 120)
    throw new HttpError(400, 'printer_request_invalid', 'limit must be between 1 and 120');
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
