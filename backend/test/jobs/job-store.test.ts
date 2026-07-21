import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createDatabase,
  type Database,
  withTransaction,
} from '../../src/platform/database/index.js';
import {
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  type JobDatabaseSchema,
  JobLeaseLostError,
  renewJobLease,
  reportJobProgress,
} from '../../src/platform/jobs/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('PostgreSQL durable jobs', () => {
  let database: Database<JobDatabaseSchema>;
  const schemaName = `f07_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    const setup = createDatabase<JobDatabaseSchema>(
      configuration(databaseUrl as string, 'f07-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);

    database = openDatabase('f07-test');
    const migration = await readFile(
      resolve(import.meta.dirname, '../../migrations/0001_durable_jobs.up.sql'),
      'utf8',
    );
    await sql.raw(migration).execute(database);
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<JobDatabaseSchema>(
      configuration(databaseUrl as string, 'f07-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('enqueues atomically and deduplicates concurrent requests by type and key', async () => {
    await expect(
      withTransaction(database, async (transaction) => {
        await enqueueJob(transaction, {
          type: 'rolled-back',
          payloadVersion: 1,
          payload: { source: 'test' },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const rolledBack = await sql<{ count: string }>`
      select count(*) as count from jobs where type = 'rolled-back'
    `.execute(database);
    expect(rolledBack.rows[0]?.count).toBe('0');

    const [first, second] = await Promise.all([
      enqueueJob(database, {
        type: 'preview',
        payloadVersion: 1,
        payload: { assetId: 'asset-1' },
        idempotencyKey: 'asset-1',
      }),
      enqueueJob(database, {
        type: 'preview',
        payloadVersion: 1,
        payload: { assetId: 'asset-1' },
        idempotencyKey: 'asset-1',
      }),
    ]);
    expect(second.id).toBe(first.id);
    expect(second.payload).toEqual({ assetId: 'asset-1' });
  });

  it('allows only one worker to claim a job and fences stale owners', async () => {
    const now = new Date('2026-07-21T10:00:00.000Z');
    const queued = await enqueueJob(database, {
      type: 'exclusive',
      payloadVersion: 1,
      payload: {},
      availableAt: now,
    });

    const claims = await Promise.all([
      claimJob(database, {
        workerId: 'worker-a',
        leaseDurationMs: 10_000,
        now,
        types: ['exclusive'],
      }),
      claimJob(database, {
        workerId: 'worker-b',
        leaseDurationMs: 10_000,
        now,
        types: ['exclusive'],
      }),
    ]);
    const claimed = claims.find((job) => job !== null);
    expect(claims.filter((job) => job !== null)).toHaveLength(1);
    expect(claimed?.id).toBe(queued.id);
    expect(claimed?.attempts).toBe(1);

    await expect(
      reportJobProgress(database, queued.id, '00000000-0000-0000-0000-000000000000', 50),
    ).rejects.toBeInstanceOf(JobLeaseLostError);
    await reportJobProgress(
      database,
      queued.id,
      claimed?.leaseToken as string,
      40,
      { phase: 'read' },
      now,
    );
    const renewed = await renewJobLease(
      database,
      queued.id,
      claimed?.leaseToken as string,
      20_000,
      now,
    );
    expect(renewed).toEqual(new Date('2026-07-21T10:00:20.000Z'));
    await completeJob(database, queued.id, claimed?.leaseToken as string, now);
  });

  it('retries with bounded backoff and reaches a terminal dead-letter state', async () => {
    const start = new Date('2026-07-21T11:00:00.000Z');
    await enqueueJob(database, {
      type: 'retryable',
      payloadVersion: 1,
      payload: {},
      maxAttempts: 2,
      availableAt: start,
    });
    const first = await claimJob(database, {
      workerId: 'worker-a',
      leaseDurationMs: 1_000,
      now: start,
      types: ['retryable'],
    });
    const retry = await failJob(
      database,
      first?.id as string,
      first?.leaseToken as string,
      { code: 'temporary', message: 'Temporary failure', retryable: true },
      { baseDelayMs: 1_000, maximumDelayMs: 10_000 },
      start,
    );
    expect(retry.state).toBe('queued');
    expect(retry.nextAttemptAt).toEqual(new Date('2026-07-21T11:00:01.000Z'));
    await expect(
      claimJob(database, {
        workerId: 'worker-b',
        leaseDurationMs: 1_000,
        now: new Date('2026-07-21T11:00:00.999Z'),
        types: ['retryable'],
      }),
    ).resolves.toBeNull();

    const second = await claimJob(database, {
      workerId: 'worker-b',
      leaseDurationMs: 1_000,
      now: new Date('2026-07-21T11:00:01.000Z'),
      types: ['retryable'],
    });
    const dead = await failJob(
      database,
      second?.id as string,
      second?.leaseToken as string,
      { code: 'still_temporary', message: 'Still failing', retryable: true },
      { baseDelayMs: 1_000, maximumDelayMs: 10_000 },
      new Date('2026-07-21T11:00:01.000Z'),
    );
    expect(dead.state).toBe('dead_letter');
    expect(dead.completedAt).not.toBeNull();
    await expect(
      claimJob(database, {
        workerId: 'worker-c',
        leaseDurationMs: 1_000,
        now: new Date('2026-07-21T11:00:10.000Z'),
        types: ['retryable'],
      }),
    ).resolves.toBeNull();
  });

  it('reclaims expired work after a worker restart and dead-letters an abandoned final attempt', async () => {
    const start = new Date('2026-07-21T12:00:00.000Z');
    await enqueueJob(database, {
      type: 'restart',
      payloadVersion: 1,
      payload: {},
      maxAttempts: 2,
      availableAt: start,
    });
    await enqueueJob(database, {
      type: 'abandoned-final',
      payloadVersion: 1,
      payload: {},
      maxAttempts: 1,
      availableAt: start,
    });
    const original = await claimJob(database, {
      workerId: 'worker-before-restart',
      leaseDurationMs: 1_000,
      now: start,
      types: ['restart'],
    });
    await claimJob(database, {
      workerId: 'worker-before-restart',
      leaseDurationMs: 1_000,
      now: start,
      types: ['abandoned-final'],
    });

    await closeDatabase(database);
    database = openDatabase('f07-after-restart');
    const afterExpiry = new Date('2026-07-21T12:00:01.001Z');
    const reclaimed = await claimJob(database, {
      workerId: 'worker-after-restart',
      leaseDurationMs: 1_000,
      now: afterExpiry,
      types: ['restart'],
    });
    expect(reclaimed?.id).toBe(original?.id);
    expect(reclaimed?.attempts).toBe(2);
    expect(reclaimed?.leaseToken).not.toBe(original?.leaseToken);
    await expect(
      completeJob(database, original?.id as string, original?.leaseToken as string, afterExpiry),
    ).rejects.toBeInstanceOf(JobLeaseLostError);

    await expect(
      claimJob(database, {
        workerId: 'worker-after-restart',
        leaseDurationMs: 1_000,
        now: afterExpiry,
        types: ['abandoned-final'],
      }),
    ).resolves.toBeNull();
    const abandoned = await sql<{ state: string; last_error_code: string }>`
      select state, last_error_code from jobs where type = 'abandoned-final'
    `.execute(database);
    expect(abandoned.rows[0]).toEqual({ state: 'dead_letter', last_error_code: 'lease_expired' });
  });

  function openDatabase(applicationName: string): Database<JobDatabaseSchema> {
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    return createDatabase<JobDatabaseSchema>(configuration(url.toString(), applicationName));
  }
});

function configuration(connectionString: string, applicationName: string) {
  return {
    connectionString,
    maximumPoolSize: 4,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: 5_000,
    applicationName,
  };
}
