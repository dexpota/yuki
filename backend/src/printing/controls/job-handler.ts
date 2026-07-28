import type { Kysely } from 'kysely';

import { claimJob, completeJob, failJob, type Job } from '../../platform/jobs/index.js';
import { PrinterControlCommandError, type PrinterControlCommandService } from './command.js';
import type { PrinterControlDatabaseSchema } from './contracts.js';
import { printerControlJobType, printerControlPayloadVersion } from './service.js';

interface PrinterControlPayload {
  readonly ownerId: string;
  readonly commandId: string;
}

export async function handlePrinterControlJob(
  database: Kysely<PrinterControlDatabaseSchema>,
  commands: PrinterControlCommandService,
  job: Job,
): Promise<void> {
  if (
    job.type !== printerControlJobType ||
    job.payloadVersion !== printerControlPayloadVersion ||
    !job.leaseToken
  )
    throw new TypeError('Unsupported or unclaimed printer control job.');
  const payload = parsePayload(job.payload);
  try {
    await commands.execute(payload.ownerId, payload.commandId);
    await completeJob(database, job.id, job.leaseToken);
  } catch (error) {
    const code =
      error instanceof PrinterControlCommandError ? error.code : 'printer_control_failed';
    await failJob(
      database,
      job.id,
      job.leaseToken,
      { code, message: 'Printer control failed.', retryable: false },
      { baseDelayMs: 1_000, maximumDelayMs: 1_000 },
    );
  }
}

export async function processNextPrinterControlJob(
  database: Kysely<PrinterControlDatabaseSchema>,
  commands: PrinterControlCommandService,
  options: { readonly workerId: string; readonly leaseDurationMs: number },
): Promise<boolean> {
  const job = await claimJob(database, { ...options, types: [printerControlJobType] });
  if (!job) return false;
  await handlePrinterControlJob(database, commands, job);
  return true;
}

function parsePayload(value: unknown): PrinterControlPayload {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>).ownerId !== 'string' ||
    typeof (value as Record<string, unknown>).commandId !== 'string'
  )
    throw new TypeError('Invalid printer control payload.');
  return value as PrinterControlPayload;
}
