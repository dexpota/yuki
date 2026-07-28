import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';

import type { OwnerContext } from '../identity/index.js';
import { HttpError, sendSse, SseHub } from '../platform/http/index.js';
import type { PrinterMonitoringDatabaseSchema } from './monitoring/public.js';
import type { QueueDatabaseSchema } from './queue/index.js';

export type PrinterEventsDatabaseSchema = PrinterMonitoringDatabaseSchema & QueueDatabaseSchema;

export interface PrinterEventsIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export function registerPrinterEventsFeature(
  application: FastifyInstance,
  options: {
    readonly database: Kysely<PrinterEventsDatabaseSchema>;
    readonly identity: PrinterEventsIdentityBoundary;
    readonly pollIntervalMs?: number;
  },
): void {
  const authenticated = { preHandler: options.identity.requireOwner };
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  application.get(
    '/api/v1/printing/printers/:printerId/events',
    authenticated,
    async (request, reply) => {
      const printerId = pathId(request);
      const ownerId = options.identity.ownerForRequest(request).owner.id;
      let previous = await revision(options.database, ownerId, printerId);
      if (previous === null) throw new HttpError(404, 'printer_not_found', 'Printer not found');

      const hub = new SseHub({ retainedEvents: 10, subscriberBuffer: 10 });
      let polling = false;
      const timer = setInterval(() => {
        if (polling) return;
        polling = true;
        void revision(options.database, ownerId, printerId)
          .then((next) => {
            if (next !== null && next !== previous) {
              previous = next;
              hub.publish({
                id: randomUUID(),
                resourceType: 'printer',
                resourceId: printerId,
                revision: next,
                kind: 'printer-invalidated',
              });
            }
          })
          .catch(() => undefined)
          .finally(() => {
            polling = false;
          });
      }, pollIntervalMs);
      try {
        await sendSse(request, reply, hub);
      } finally {
        clearInterval(timer);
      }
    },
  );
}

async function revision(
  database: Kysely<PrinterEventsDatabaseSchema>,
  ownerId: string,
  printerId: string,
): Promise<string | null> {
  const [printer, monitoring, queue] = await Promise.all([
    database
      .selectFrom('printers')
      .select(['updated_at', 'version'])
      .where('id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst(),
    database
      .selectFrom('printer_monitoring_state')
      .select('updated_at')
      .where('printer_id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst(),
    database
      .selectFrom('printing_queue_entries')
      .select(['updated_at', 'version'])
      .where('printer_id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst(),
  ]);
  if (printer === undefined) return null;
  return [
    dateRevision(printer.updated_at),
    printer.version,
    monitoring === undefined ? '-' : dateRevision(monitoring.updated_at),
    queue === undefined ? '-' : dateRevision(queue.updated_at),
    queue?.version ?? '-',
  ].join(':');
}

function dateRevision(value: Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function pathId(request: FastifyRequest): string {
  const value = (request.params as Record<string, unknown>).printerId;
  if (typeof value !== 'string' || value.trim() === '')
    throw new HttpError(400, 'printer_request_invalid', 'printerId is required');
  return value;
}
