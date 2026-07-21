import { readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  handleLocalImportJob,
  type ImportDatabaseSchema,
  LocalImportService,
  localImportJobType,
  UploadLimitExceededError,
} from '../../src/importing/index.js';
import { closeDatabase, createDatabase, type Database } from '../../src/platform/database/index.js';
import { claimJob } from '../../src/platform/jobs/index.js';
import { LocalBlobStore } from '../../src/platform/storage/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('durable local file imports', () => {
  let database: Database<ImportDatabaseSchema>;
  let blobStore: LocalBlobStore;
  let storageRoot: string;
  const schemaName = `m01_${process.pid}_${Date.now()}`;
  const ownerId = '10000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    const setup = createDatabase<ImportDatabaseSchema>(
      configuration(databaseUrl as string, 'm01-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);

    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<ImportDatabaseSchema>(configuration(url.toString(), 'm01-test'));
    await applyMigration(database, '0001_durable_jobs.up.sql');
    await applyMigration(database, '0002_storage_objects.up.sql');
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerId})`.execute(database);
    await applyMigration(database, '0004_catalogue.up.sql');
    await applyMigration(database, '0005_import_sessions.up.sql');

    storageRoot = join(tmpdir(), `yuki-m01-${process.pid}-${Date.now()}`);
    blobStore = await LocalBlobStore.create(storageRoot);
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<ImportDatabaseSchema>(
      configuration(databaseUrl as string, 'm01-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  it('streams, hashes, queues, and atomically publishes the retained original', async () => {
    const bytes = Buffer.from('solid cube\nendsolid cube\n');
    const service = new LocalImportService(database, blobStore, {
      maximumUploadBytes: 1024,
      progressIntervalBytes: 5,
    });
    const queued = await service.receive({
      ownerId,
      originalFilename: 'cube.stl',
      claimedMimeType: 'model/stl',
      modelName: 'Calibration cube',
      idempotencyKey: 'cube-upload',
      source: Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]),
    });

    expect(queued).toMatchObject({ state: 'queued', uploadedBytes: bytes.length, progress: 50 });
    expect(queued.checksum).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      database
        .selectFrom('catalogue_models')
        .select('id')
        .where('name', '=', 'Calibration cube')
        .execute(),
    ).resolves.toHaveLength(0);

    const job = await claimJob(database, {
      workerId: 'm01-test-worker',
      leaseDurationMs: 10_000,
      types: [localImportJobType],
    });
    expect(job).not.toBeNull();
    await handleLocalImportJob(database, service, required(job, 'Expected queued import job'));

    const completed = await service.get(ownerId, queued.id);
    expect(completed).toMatchObject({ state: 'succeeded', progress: 100 });
    expect(completed.modelId).not.toBeNull();
    const asset = await database
      .selectFrom('catalogue_assets')
      .innerJoin('stored_objects', 'stored_objects.id', 'catalogue_assets.stored_object_id')
      .select(['catalogue_assets.published_at', 'stored_objects.object_key'])
      .where('catalogue_assets.model_id', '=', completed.modelId)
      .executeTakeFirstOrThrow();
    expect(asset.published_at).not.toBeNull();
    expect(await readStream(await blobStore.read(asset.object_key))).toEqual(bytes);

    const restarted = new LocalImportService(database, blobStore, { maximumUploadBytes: 1024 });
    await expect(restarted.publish(queued.id)).resolves.toMatchObject({
      id: queued.id,
      state: 'succeeded',
      modelId: completed.modelId,
    });
    await expect(
      database
        .selectFrom('catalogue_models')
        .select('id')
        .where('name', '=', 'Calibration cube')
        .execute(),
    ).resolves.toHaveLength(1);
  });

  it('returns the durable session for an idempotent replay without reading it again', async () => {
    const service = new LocalImportService(database, blobStore, { maximumUploadBytes: 1024 });
    const replay = await service.receive({
      ownerId,
      originalFilename: 'ignored.stl',
      claimedMimeType: 'model/stl',
      modelName: 'Ignored',
      idempotencyKey: 'cube-upload',
      source: unreadableSource(),
    });
    expect(replay).toMatchObject({ state: 'succeeded', modelName: 'Calibration cube' });
    await expect(
      database
        .selectFrom('import_sessions')
        .select('id')
        .where('idempotency_key', '=', 'cube-upload')
        .execute(),
    ).resolves.toHaveLength(1);
  });

  it('records a bounded failure and leaves no quarantine file', async () => {
    const service = new LocalImportService(database, blobStore, {
      maximumUploadBytes: 4,
      progressIntervalBytes: 1,
    });
    await expect(
      service.receive({
        ownerId,
        originalFilename: 'large.bin',
        claimedMimeType: 'application/octet-stream',
        modelName: 'Too large',
        source: Readable.from([Buffer.from('123'), Buffer.from('456')]),
      }),
    ).rejects.toSatisfy((error: unknown) => hasCause(error, UploadLimitExceededError));

    await expect(
      database
        .selectFrom('import_sessions')
        .select(['state', 'error_code'])
        .where('model_name', '=', 'Too large')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: 'failed', error_code: 'upload_too_large' });
    await expect(readdir(join(storageRoot, 'staging'))).resolves.toHaveLength(0);
  });

  it('dead-letters a publication failure without exposing a partial model', async () => {
    const service = new LocalImportService(database, blobStore, { maximumUploadBytes: 1024 });
    const queued = await service.receive({
      ownerId,
      originalFilename: 'broken.stl',
      claimedMimeType: 'model/stl',
      modelName: 'Broken import',
      source: Readable.from([Buffer.from('solid broken')]),
    });
    const objectId = await database
      .selectFrom('import_sessions')
      .select('stored_object_id')
      .where('id', '=', queued.id)
      .executeTakeFirstOrThrow();
    const storedObjectId = required(objectId.stored_object_id, 'Expected stored object');
    await database
      .updateTable('stored_objects')
      .set({ checksum: 'f'.repeat(64) })
      .where('id', '=', storedObjectId)
      .execute();

    const job = await claimJob(database, {
      workerId: 'm01-failing-worker',
      leaseDurationMs: 10_000,
      types: [localImportJobType],
    });
    expect(job).not.toBeNull();
    await handleLocalImportJob(database, service, required(job, 'Expected failing import job'), {
      isRetryable: () => false,
    });

    await expect(service.get(ownerId, queued.id)).resolves.toMatchObject({
      state: 'failed',
      modelId: null,
      error: { code: 'local_import_failed' },
    });
    await expect(
      database
        .selectFrom('catalogue_models')
        .select('id')
        .where('name', '=', 'Broken import')
        .execute(),
    ).resolves.toHaveLength(0);
    await expect(
      database
        .selectFrom('stored_objects')
        .select('state')
        .where('id', '=', storedObjectId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: 'pending_delete' });
  });

  it('rolls migration 0005 down independently', async () => {
    await applyMigration(database, '0005_import_sessions.down.sql');
    const relation = await sql<{
      relation: string | null;
    }>`select to_regclass('import_sessions')::text as relation`.execute(database);
    expect(relation.rows[0]?.relation).toBeNull();
    await applyMigration(database, '0005_import_sessions.up.sql');
  });
});

async function applyMigration(
  database: Database<ImportDatabaseSchema>,
  filename: string,
): Promise<void> {
  const migration = await readFile(
    new URL(`../../migrations/${filename}`, import.meta.url),
    'utf8',
  );
  await sql.raw(migration).execute(database);
}

async function readStream(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function unreadableSource(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          throw new Error('Idempotent replay consumed the body');
        },
      };
    },
  };
}

function hasCause(error: unknown, kind: new (message?: string) => Error): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (Object.prototype.isPrototypeOf.call(kind.prototype, current)) return true;
    current = current.cause;
  }
  return false;
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function configuration(connectionString: string, applicationName: string) {
  return {
    connectionString,
    maximumPoolSize: 2,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: 5_000,
    applicationName,
  };
}
