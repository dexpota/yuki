import type { Kysely } from 'kysely';

import {
  claimJob,
  completeJob,
  failJob,
  type Job,
  reportJobProgress,
} from '../../platform/jobs/index.js';
import type { BlobStore } from '../../platform/storage/index.js';
import type { QueueDatabaseSchema } from './contracts.js';
import type { GcodeFactsProvider } from './gcode-facts-provider.js';
import {
  type QueueService,
  queueEvaluationJobType,
  queueEvaluationPayloadVersion,
} from './service.js';

export async function handleQueueEvaluationJob(
  database: Kysely<QueueDatabaseSchema>,
  blobStore: BlobStore,
  facts: GcodeFactsProvider,
  queue: QueueService,
  job: Job,
): Promise<void> {
  if (
    job.type !== queueEvaluationJobType ||
    job.payloadVersion !== queueEvaluationPayloadVersion ||
    !job.leaseToken
  )
    throw new TypeError('Unsupported or unclaimed queue evaluation job.');
  const payload = parsePayload(job.payload);
  try {
    const source = await queue.evaluationSource(payload.ownerId, payload.entryId);
    if (source.state !== 'evaluating') {
      await completeJob(database, job.id, job.leaseToken);
      return;
    }
    await reportJobProgress(database, job.id, job.leaseToken, 20, { stage: 'parsing' });
    const processorFacts = await facts.parse({
      byteSize: source.byteSize,
      open: () => blobStore.read(source.objectKey),
    });
    await reportJobProgress(database, job.id, job.leaseToken, 70, { stage: 'evaluating' });
    await queue.completeEvaluation(payload.ownerId, payload.entryId, processorFacts);
    await completeJob(database, job.id, job.leaseToken);
  } catch {
    const failed = await failJob(
      database,
      job.id,
      job.leaseToken,
      {
        code: 'queue_evaluation_failed',
        message: 'Queue compatibility evaluation could not be completed',
        retryable: true,
      },
      { baseDelayMs: 1_000, maximumDelayMs: 60_000 },
    );
    if (failed.state === 'dead_letter')
      await queue.failEvaluation(payload.ownerId, payload.entryId);
  }
}

export async function processNextQueueEvaluationJob(
  database: Kysely<QueueDatabaseSchema>,
  blobStore: BlobStore,
  facts: GcodeFactsProvider,
  queue: QueueService,
  options: { readonly workerId: string; readonly leaseDurationMs: number },
): Promise<boolean> {
  const job = await claimJob(database, { ...options, types: [queueEvaluationJobType] });
  if (!job) return false;
  await handleQueueEvaluationJob(database, blobStore, facts, queue, job);
  return true;
}

function parsePayload(value: unknown): { readonly ownerId: string; readonly entryId: string } {
  if (
    !value ||
    typeof value !== 'object' ||
    !('ownerId' in value) ||
    typeof value.ownerId !== 'string' ||
    !('entryId' in value) ||
    typeof value.entryId !== 'string'
  )
    throw new TypeError('Queue evaluation payload is invalid.');
  return { ownerId: value.ownerId, entryId: value.entryId };
}
