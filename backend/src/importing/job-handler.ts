import type { Kysely } from 'kysely';

import {
  completeJob,
  failJob,
  type Job,
  type RetryPolicy,
  reportJobProgress,
} from '../platform/jobs/index.js';
import type { ImportDatabaseSchema } from './schema.js';
import {
  type LocalImportService,
  localImportJobType,
  localImportPayloadVersion,
} from './service.js';

export interface LocalImportJobHandlerOptions {
  readonly retryPolicy?: RetryPolicy;
  readonly isRetryable?: (error: unknown) => boolean;
}

/**
 * Runs a claimed local-import job. Publication is restart-safe: a crash after
 * commit is handled by publish() returning the already-completed session.
 */
export async function handleLocalImportJob(
  database: Kysely<ImportDatabaseSchema>,
  service: LocalImportService,
  job: Job,
  options: LocalImportJobHandlerOptions = {},
): Promise<void> {
  if (job.type !== localImportJobType || job.payloadVersion !== localImportPayloadVersion) {
    throw new TypeError('Unsupported local import job contract');
  }
  if (!job.leaseToken) throw new TypeError('Local import job must be claimed before handling');
  const sessionId = sessionIdFrom(job.payload);
  try {
    await reportJobProgress(database, job.id, job.leaseToken, 60, { stage: 'publishing' });
    await service.publish(sessionId);
    await completeJob(database, job.id, job.leaseToken);
  } catch (error) {
    const failed = await failJob(
      database,
      job.id,
      job.leaseToken,
      {
        code: 'local_import_failed',
        message: 'The local file import could not be published',
        retryable: options.isRetryable?.(error) ?? true,
      },
      options.retryPolicy ?? { baseDelayMs: 1_000, maximumDelayMs: 60_000 },
    );
    if (failed.state === 'dead_letter') {
      await service.markProcessingFailure(sessionId, {
        code: failed.lastErrorCode ?? 'local_import_failed',
        message: failed.lastErrorMessage ?? 'The local file import could not be published',
      });
    }
  }
}

function sessionIdFrom(payload: unknown): string {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('sessionId' in payload) ||
    typeof payload.sessionId !== 'string'
  ) {
    throw new TypeError('Local import job payload is invalid');
  }
  return payload.sessionId;
}
