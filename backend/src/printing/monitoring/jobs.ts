import type { Kysely } from 'kysely';

import { claimJob, completeJob, enqueueJob, failJob, type Job } from '../../platform/jobs/index.js';
import type { PollReason, PrinterMonitoringDatabaseSchema } from './schema.js';
import {
  MonitoredPrinterNotFoundError,
  PrinterMonitoringDisabledError,
  type PrinterMonitoringService,
} from './service.js';

export const printerPollJobType = 'printing.poll-printer';
export const printerPollPayloadVersion = 1;

export type PrinterPollPayload = {
  readonly ownerId: string;
  readonly printerId: string;
  readonly reason: PollReason;
};

export interface SchedulePrinterPollsOptions {
  readonly reason: 'scheduled' | 'startup';
  /** Stable for one scheduler tick or worker startup; used to deduplicate restart-safe enqueue. */
  readonly cycleId: string;
  readonly now?: Date;
}

export interface PrinterPollSchedulerOptions {
  readonly periodMs?: number;
  readonly now?: () => Date;
}

/**
 * Timer-agnostic scheduler boundary. Composition calls startup once and tick periodically;
 * durable job idempotency makes repeated calls for the same cycle safe.
 */
export class PrinterPollScheduler {
  readonly #periodMs: number;
  readonly #now: () => Date;

  public constructor(
    private readonly database: Kysely<PrinterMonitoringDatabaseSchema>,
    options: PrinterPollSchedulerOptions = {},
  ) {
    this.#periodMs = positiveInteger(options.periodMs ?? 15_000, 'periodMs');
    this.#now = options.now ?? (() => new Date());
  }

  public scheduleStartup(startupId: string): Promise<number> {
    return scheduleEnabledPrinterPolls(this.database, {
      reason: 'startup',
      cycleId: startupId,
      now: this.#now(),
    });
  }

  public schedulePeriodic(): Promise<number> {
    const now = this.#now();
    return scheduleEnabledPrinterPolls(this.database, {
      reason: 'scheduled',
      cycleId: String(Math.floor(now.getTime() / this.#periodMs)),
      now,
    });
  }
}

export async function scheduleEnabledPrinterPolls(
  database: Kysely<PrinterMonitoringDatabaseSchema>,
  options: SchedulePrinterPollsOptions,
): Promise<number> {
  if (!options.cycleId.trim() || options.cycleId.length > 200)
    throw new TypeError('cycleId is invalid');
  const printers = await database
    .selectFrom('printers')
    .select(['id', 'owner_id'])
    .where('enabled', '=', true)
    .orderBy('id', 'asc')
    .execute();
  for (const printer of printers) {
    await enqueueJob(
      database,
      {
        type: printerPollJobType,
        payloadVersion: printerPollPayloadVersion,
        payload: {
          ownerId: printer.owner_id,
          printerId: printer.id,
          reason: options.reason,
        },
        idempotencyKey: `${options.reason}:${options.cycleId}:${printer.id}`,
        maxAttempts: 5,
      },
      options.now,
    );
  }
  return printers.length;
}

export interface ProcessNextPrinterPollOptions {
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly now?: Date;
}

export async function processNextPrinterPollJob(
  database: Kysely<PrinterMonitoringDatabaseSchema>,
  monitoring: PrinterMonitoringService,
  options: ProcessNextPrinterPollOptions,
): Promise<boolean> {
  const job = await claimJob(database, {
    workerId: options.workerId,
    leaseDurationMs: options.leaseDurationMs,
    ...(options.now ? { now: options.now } : {}),
    types: [printerPollJobType],
  });
  if (!job) return false;
  await handlePrinterPollJob(database, monitoring, job, options.now);
  return true;
}

export async function handlePrinterPollJob(
  database: Kysely<PrinterMonitoringDatabaseSchema>,
  monitoring: PrinterMonitoringService,
  job: Job,
  now = new Date(),
): Promise<void> {
  if (!job.leaseToken) throw new TypeError('Printer poll job must be claimed before handling');
  let payload: PrinterPollPayload;
  try {
    payload = parsePayload(job);
  } catch {
    await failJob(
      database,
      job.id,
      job.leaseToken,
      {
        code: 'invalid_printer_poll_job',
        message: 'Printer poll job is invalid',
        retryable: false,
      },
      { baseDelayMs: 1_000, maximumDelayMs: 30_000 },
      now,
    );
    return;
  }
  try {
    await monitoring.poll(payload.ownerId, payload.printerId, payload.reason);
    await completeJob(database, job.id, job.leaseToken, now);
  } catch (error) {
    if (
      error instanceof PrinterMonitoringDisabledError ||
      error instanceof MonitoredPrinterNotFoundError
    ) {
      await completeJob(database, job.id, job.leaseToken, now);
      return;
    }
    await failJob(
      database,
      job.id,
      job.leaseToken,
      {
        code: 'printer_poll_failed',
        message: 'Printer poll could not be persisted',
        retryable: true,
      },
      { baseDelayMs: 1_000, maximumDelayMs: 60_000 },
      now,
    );
  }
}

function parsePayload(job: Job): PrinterPollPayload {
  if (job.type !== printerPollJobType || job.payloadVersion !== printerPollPayloadVersion)
    throw new TypeError('Unsupported printer poll job');
  const payload = job.payload;
  if (
    !isObject(payload) ||
    typeof payload.ownerId !== 'string' ||
    typeof payload.printerId !== 'string' ||
    (payload.reason !== 'scheduled' &&
      payload.reason !== 'startup' &&
      payload.reason !== 'manual' &&
      payload.reason !== 'reconnect')
  )
    throw new TypeError('Invalid printer poll payload');
  return {
    ownerId: payload.ownerId,
    printerId: payload.printerId,
    reason: payload.reason,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be positive`);
  return value;
}
