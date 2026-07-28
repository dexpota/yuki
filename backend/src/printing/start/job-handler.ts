import type { Kysely } from 'kysely';

import { claimJob, completeJob, failJob, type Job } from '../../platform/jobs/index.js';
import { PrintStartCommandError, type PrintStartCommandService } from './command.js';
import type { PrintStartDatabaseSchema } from './contracts.js';
import { printStartJobType, printStartPayloadVersion } from './service.js';

interface PrintStartPayload {
  readonly ownerId: string;
  readonly queueEntryId: string;
}

export async function handlePrintStartJob(
  database: Kysely<PrintStartDatabaseSchema>,
  commands: PrintStartCommandService,
  job: Job,
): Promise<void> {
  if (
    job.type !== printStartJobType ||
    job.payloadVersion !== printStartPayloadVersion ||
    !job.leaseToken
  )
    throw new TypeError('Unsupported or unclaimed print start job.');
  const payload = parsePayload(job.payload);
  try {
    await commands.execute(payload.ownerId, payload.queueEntryId);
    await completeJob(database, job.id, job.leaseToken);
  } catch (error) {
    const failure =
      error instanceof PrintStartCommandError
        ? { code: error.code, message: error.message, retryable: error.retryable }
        : { code: 'print_start_failed', message: 'Print start failed.', retryable: false };
    const failed = await failJob(database, job.id, job.leaseToken, failure, {
      baseDelayMs: 1_000,
      maximumDelayMs: 30_000,
    });
    if (failed.state === 'dead_letter')
      await commands.abandon(payload.ownerId, payload.queueEntryId, failure.code);
  }
}

export async function processNextPrintStartJob(
  database: Kysely<PrintStartDatabaseSchema>,
  commands: PrintStartCommandService,
  options: { readonly workerId: string; readonly leaseDurationMs: number },
): Promise<boolean> {
  const job = await claimJob(database, { ...options, types: [printStartJobType] });
  if (!job) return false;
  await handlePrintStartJob(database, commands, job);
  return true;
}

function parsePayload(value: unknown): PrintStartPayload {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>).ownerId !== 'string' ||
    typeof (value as Record<string, unknown>).queueEntryId !== 'string'
  )
    throw new TypeError('Invalid print start payload.');
  return value as PrintStartPayload;
}
