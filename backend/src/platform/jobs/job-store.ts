import { randomUUID } from 'node:crypto';

import { type Kysely, type Selectable, sql, type Transaction } from 'kysely';

import { retryDelayMs } from './backoff.js';
import type {
  ClaimJobOptions,
  EnqueueJob,
  Job,
  JobDatabaseSchema,
  JobFailure,
  JobTable,
  JsonValue,
  RetryPolicy,
} from './types.js';

type JobDatabase<Schema extends JobDatabaseSchema> = Kysely<Schema>;
type JobExecutor<Schema extends JobDatabaseSchema> = Kysely<Schema> | Transaction<Schema>;
type JobRow = Selectable<JobTable>;

export class JobLeaseLostError extends Error {
  override readonly name = 'JobLeaseLostError';
}

export async function enqueueJob<P extends JsonValue, Schema extends JobDatabaseSchema>(
  database: JobExecutor<Schema>,
  input: EnqueueJob<P>,
  now = new Date(),
): Promise<Job<P>> {
  validateEnqueue(input);
  const id = randomUUID();
  const maxAttempts = input.maxAttempts ?? 5;
  const availableAt = input.availableAt ?? now;
  const idempotencyKey = input.idempotencyKey ?? null;

  const result = await sql<JobRow>`
    insert into jobs (
      id, type, payload_version, payload, state, attempts, max_attempts, progress,
      next_attempt_at, idempotency_key, created_at, updated_at
    ) values (
      ${id}, ${input.type}, ${input.payloadVersion}, ${JSON.stringify(input.payload)}::jsonb,
      'queued', 0, ${maxAttempts}, 0, ${availableAt}, ${idempotencyKey}, ${now}, ${now}
    )
    on conflict (type, idempotency_key) where idempotency_key is not null
    do update set idempotency_key = excluded.idempotency_key
    returning *
  `.execute(database);

  return mapJob<P>(requiredRow(result.rows[0]));
}

export async function claimJob<Schema extends JobDatabaseSchema>(
  database: JobDatabase<Schema>,
  options: ClaimJobOptions,
): Promise<Job | null> {
  validateClaim(options);
  if (options.types?.length === 0) return null;

  const now = options.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + options.leaseDurationMs);
  const leaseToken = randomUUID();
  const typeFilter = options.types
    ? sql`and type in (${sql.join(options.types.map((type) => sql`${type}`))})`
    : sql``;

  return database.transaction().execute(async (transaction) => {
    await sql`
      update jobs
      set state = 'dead_letter',
          last_error_code = 'lease_expired',
          last_error_message = 'Worker lease expired after the final attempt',
          lease_owner = null,
          lease_token = null,
          lease_expires_at = null,
          completed_at = ${now},
          updated_at = ${now}
      where state = 'running'
        and lease_expires_at <= ${now}
        and attempts >= max_attempts
    `.execute(transaction);

    const result = await sql<JobRow>`
      with candidate as (
        select id
        from jobs
        where attempts < max_attempts
          and (
            (state = 'queued' and next_attempt_at <= ${now})
            or (state = 'running' and lease_expires_at <= ${now})
          )
          ${typeFilter}
        order by next_attempt_at asc, created_at asc
        for update skip locked
        limit 1
      )
      update jobs
      set state = 'running',
          attempts = attempts + 1,
          progress = 0,
          progress_detail = null,
          lease_owner = ${options.workerId},
          lease_token = ${leaseToken},
          lease_expires_at = ${leaseExpiresAt},
          started_at = coalesce(started_at, ${now}),
          updated_at = ${now}
      from candidate
      where jobs.id = candidate.id
      returning jobs.*
    `.execute(transaction);

    const row = result.rows[0];
    return row ? mapJob(row) : null;
  });
}

export async function renewJobLease<Schema extends JobDatabaseSchema>(
  database: JobExecutor<Schema>,
  jobId: string,
  leaseToken: string,
  leaseDurationMs: number,
  now = new Date(),
): Promise<Date> {
  positiveDuration(leaseDurationMs, 'leaseDurationMs');
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
  const result = await sql<{ readonly lease_expires_at: Date }>`
    update jobs
    set lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}
    where id = ${jobId} and state = 'running' and lease_token = ${leaseToken}
    returning lease_expires_at
  `.execute(database);
  if (!result.rows[0]) throw new JobLeaseLostError(`Lease for job ${jobId} is no longer owned`);
  return result.rows[0].lease_expires_at;
}

export async function reportJobProgress<Schema extends JobDatabaseSchema>(
  database: JobExecutor<Schema>,
  jobId: string,
  leaseToken: string,
  progress: number,
  detail: JsonValue | null = null,
  now = new Date(),
): Promise<void> {
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    throw new RangeError('progress must be an integer from 0 through 100');
  }
  const result = await sql`
    update jobs
    set progress = ${progress}, progress_detail = ${JSON.stringify(detail)}::jsonb, updated_at = ${now}
    where id = ${jobId} and state = 'running' and lease_token = ${leaseToken}
  `.execute(database);
  requireChanged(result.numAffectedRows, jobId);
}

export async function completeJob<Schema extends JobDatabaseSchema>(
  database: JobExecutor<Schema>,
  jobId: string,
  leaseToken: string,
  now = new Date(),
): Promise<void> {
  const result = await sql`
    update jobs
    set state = 'succeeded', progress = 100, lease_owner = null, lease_token = null,
        lease_expires_at = null, completed_at = ${now}, updated_at = ${now}
    where id = ${jobId} and state = 'running' and lease_token = ${leaseToken}
  `.execute(database);
  requireChanged(result.numAffectedRows, jobId);
}

export async function failJob<Schema extends JobDatabaseSchema>(
  database: JobDatabase<Schema>,
  jobId: string,
  leaseToken: string,
  failure: JobFailure,
  retryPolicy: RetryPolicy,
  now = new Date(),
): Promise<Job> {
  if (!failure.code || !failure.message)
    throw new TypeError('failure code and message are required');

  return database.transaction().execute(async (transaction) => {
    const locked = await sql<Pick<JobRow, 'attempts' | 'max_attempts'>>`
      select attempts, max_attempts from jobs
      where id = ${jobId} and state = 'running' and lease_token = ${leaseToken}
      for update
    `.execute(transaction);
    const current = locked.rows[0];
    if (!current) throw new JobLeaseLostError(`Lease for job ${jobId} is no longer owned`);

    const willRetry = failure.retryable && current.attempts < current.max_attempts;
    const nextAttemptAt = willRetry
      ? new Date(now.getTime() + retryDelayMs(current.attempts, retryPolicy))
      : now;
    const result = await sql<JobRow>`
      update jobs
      set state = ${willRetry ? 'queued' : 'dead_letter'},
          next_attempt_at = ${nextAttemptAt},
          lease_owner = null,
          lease_token = null,
          lease_expires_at = null,
          last_error_code = ${failure.code},
          last_error_message = ${failure.message},
          completed_at = ${willRetry ? null : now},
          updated_at = ${now}
      where id = ${jobId}
      returning *
    `.execute(transaction);
    return mapJob(requiredRow(result.rows[0]));
  });
}

function validateEnqueue(input: EnqueueJob<JsonValue>): void {
  if (!input.type.trim()) throw new TypeError('job type is required');
  if (!Number.isSafeInteger(input.payloadVersion) || input.payloadVersion < 1) {
    throw new RangeError('payloadVersion must be a positive integer');
  }
  if (
    input.maxAttempts !== undefined &&
    (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1)
  ) {
    throw new RangeError('maxAttempts must be a positive integer');
  }
  if (input.idempotencyKey !== undefined && !input.idempotencyKey.trim()) {
    throw new TypeError('idempotencyKey cannot be empty');
  }
}

function validateClaim(options: ClaimJobOptions): void {
  if (!options.workerId.trim()) throw new TypeError('workerId is required');
  positiveDuration(options.leaseDurationMs, 'leaseDurationMs');
  if (options.types?.some((type) => !type.trim())) throw new TypeError('job types cannot be empty');
}

function positiveDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
}

function requireChanged(count: bigint | undefined, jobId: string): void {
  if (count !== 1n) throw new JobLeaseLostError(`Lease for job ${jobId} is no longer owned`);
}

function requiredRow(row: JobRow | undefined): JobRow {
  if (!row) throw new Error('Job write did not return a row');
  return row;
}

function mapJob<P extends JsonValue = JsonValue>(row: JobRow): Job<P> {
  return {
    id: row.id,
    type: row.type,
    payloadVersion: row.payload_version,
    payload: row.payload as P,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    progress: row.progress,
    progressDetail: row.progress_detail,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    idempotencyKey: row.idempotency_key,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
