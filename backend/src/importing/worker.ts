import type { Kysely } from 'kysely';

import { claimJob } from '../platform/jobs/index.js';
import { handleLocalImportJob } from './job-handler.js';
import type { ImportDatabaseSchema } from './schema.js';
import { type LocalImportService, localImportJobType } from './service.js';

export interface ProcessLocalImportOptions {
  readonly workerId: string;
  readonly leaseDurationMs: number;
}

/** Claims and handles at most one local-import job. Returns false when the queue is empty. */
export async function processNextLocalImportJob(
  database: Kysely<ImportDatabaseSchema>,
  service: LocalImportService,
  options: ProcessLocalImportOptions,
): Promise<boolean> {
  const job = await claimJob(database, {
    workerId: options.workerId,
    leaseDurationMs: options.leaseDurationMs,
    types: [localImportJobType],
  });
  if (job === null) return false;
  await handleLocalImportJob(database, service, job);
  return true;
}
