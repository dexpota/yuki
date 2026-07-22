import type { Kysely } from 'kysely';

import {
  claimJob,
  completeJob,
  failJob,
  type Job,
  type RetryPolicy,
  reportJobProgress,
} from '../../platform/jobs/index.js';
import { InvalidPortablePackageError } from './manifest.js';
import {
  type CataloguePortabilityOperations,
  catalogueExportJobType,
  catalogueImportJobType,
  cataloguePortabilityPayloadVersion,
} from './operations.js';
import type { CataloguePortabilityDatabaseSchema } from './schema.js';
import type { CataloguePortabilityService } from './service.js';

export async function handleCataloguePortabilityJob(
  database: Kysely<CataloguePortabilityDatabaseSchema>,
  operations: CataloguePortabilityOperations,
  portability: CataloguePortabilityService,
  job: Job,
  retryPolicy: RetryPolicy = { baseDelayMs: 1_000, maximumDelayMs: 60_000 },
): Promise<void> {
  if (
    ![catalogueExportJobType, catalogueImportJobType].includes(job.type) ||
    job.payloadVersion !== cataloguePortabilityPayloadVersion
  )
    throw new TypeError('Unsupported catalogue portability job contract');
  if (!job.leaseToken) throw new TypeError('Catalogue portability job must be claimed');
  const operationId = operationIdFrom(job.payload);
  try {
    await reportJobProgress(database, job.id, job.leaseToken, 10, { stage: 'processing' });
    await operations.execute(operationId, portability);
    await reportJobProgress(database, job.id, job.leaseToken, 90, { stage: 'publishing' });
    await completeJob(database, job.id, job.leaseToken);
  } catch (error) {
    const invalid = error instanceof InvalidPortablePackageError;
    const failed = await failJob(
      database,
      job.id,
      job.leaseToken,
      {
        code: invalid ? 'portable_package_invalid' : 'portability_operation_failed',
        message: invalid
          ? 'The export package is invalid'
          : 'The catalogue portability operation could not be completed',
        retryable: !invalid,
      },
      retryPolicy,
    );
    if (failed.state === 'dead_letter')
      await operations.markFailed(
        operationId,
        failed.lastErrorCode ?? 'portability_operation_failed',
        failed.lastErrorMessage ?? 'The catalogue portability operation could not be completed',
      );
  }
}

export async function processNextCataloguePortabilityJob(
  database: Kysely<CataloguePortabilityDatabaseSchema>,
  operations: CataloguePortabilityOperations,
  portability: CataloguePortabilityService,
  options: { readonly workerId: string; readonly leaseDurationMs: number },
): Promise<boolean> {
  const job = await claimJob(database, {
    workerId: options.workerId,
    leaseDurationMs: options.leaseDurationMs,
    types: [catalogueExportJobType, catalogueImportJobType],
  });
  if (!job) return false;
  await handleCataloguePortabilityJob(database, operations, portability, job);
  return true;
}

function operationIdFrom(payload: unknown): string {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('operationId' in payload) ||
    typeof payload.operationId !== 'string'
  )
    throw new TypeError('Catalogue portability job payload is invalid');
  return payload.operationId;
}
