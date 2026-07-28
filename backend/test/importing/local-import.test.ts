import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CatalogueAssetDownloads,
  type CatalogueDatabaseSchema,
} from '../../src/catalogue/index.js';
import {
  handleLocalImportJob,
  type ImportDatabaseSchema,
  LocalImportPipeline,
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
    await applyMigration(database, '0009_import_processing.up.sql');
    await applyMigration(database, '0018_catalogue_version_imports.up.sql');

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

  it('publishes a processed upload as a new immutable version and streams its original', async () => {
    const sourceModel = await database
      .selectFrom('catalogue_models')
      .select(['id', 'current_version_id'])
      .where('name', '=', 'Calibration cube')
      .executeTakeFirstOrThrow();
    const originalVersionId = sourceModel.current_version_id;
    const bytes = Buffer.from('solid revised\nfacet normal 0 0 1\nendsolid revised\n');
    const service = new LocalImportService(database, blobStore, { maximumUploadBytes: 4096 });
    const queued = await service.receive({
      ownerId,
      targetModelId: sourceModel.id,
      versionLabel: 'v2',
      changeNote: 'Stronger base',
      originalFilename: 'cube-v2.stl',
      claimedMimeType: 'model/stl',
      source: Readable.from([bytes]),
    });
    expect(queued).toMatchObject({
      purpose: 'new_version',
      targetModelId: sourceModel.id,
      versionLabel: 'v2',
      modelId: null,
    });
    const pipeline = new LocalImportPipeline(database, blobStore, {
      inspect: async () => ({
        kind: 'file',
        originalDetection: detection('stl', 'model/stl'),
        files: [],
      }),
    });
    const job = required(
      await claimJob(database, {
        workerId: 'version-worker',
        leaseDurationMs: 10_000,
        types: [localImportJobType],
      }),
      'Expected version import job',
    );
    await handleLocalImportJob(database, service, job, { pipeline });

    const completed = await service.get(ownerId, queued.id);
    expect(completed).toMatchObject({
      state: 'succeeded',
      modelId: sourceModel.id,
      targetModelId: sourceModel.id,
    });
    const versions = await database
      .selectFrom('catalogue_model_versions')
      .select(['id', 'label', 'change_note', 'published_at'])
      .where('model_id', '=', sourceModel.id)
      .orderBy('created_at')
      .execute();
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ id: originalVersionId, label: 'v1' });
    expect(versions[1]).toMatchObject({
      label: 'v2',
      change_note: 'Stronger base',
      published_at: expect.any(Date),
    });
    const current = await database
      .selectFrom('catalogue_models')
      .select('current_version_id')
      .where('id', '=', sourceModel.id)
      .executeTakeFirstOrThrow();
    expect(current.current_version_id).toBe(versions[1]?.id);
    const assets = await database
      .selectFrom('catalogue_assets')
      .select(['id', 'model_version_id', 'checksum'])
      .where('model_id', '=', sourceModel.id)
      .orderBy('imported_at')
      .execute();
    expect(assets).toHaveLength(2);
    expect(assets[0]?.model_version_id).toBe(originalVersionId);
    expect(assets[1]?.model_version_id).toBe(versions[1]?.id);

    const downloads = new CatalogueAssetDownloads(
      database as unknown as Database<CatalogueDatabaseSchema>,
      blobStore,
    );
    const download = await downloads.open(
      ownerId,
      required(assets[1]?.id, 'Expected new-version asset'),
      { start: 6, end: 12 },
    );
    expect(download).toMatchObject({
      filename: 'cube-v2.stl',
      mimeType: 'model/stl',
      byteSize: bytes.length,
      range: { start: 6, end: 12 },
    });
    expect((await readStream(download.stream)).toString()).toBe('revised');
    await expect(
      downloads.open(
        '10000000-0000-4000-8000-000000000099',
        required(assets[1]?.id, 'Expected new-version asset'),
      ),
    ).rejects.toThrow('does not exist');
    await expect(
      downloads.open(ownerId, required(assets[1]?.id, 'Expected new-version asset'), {
        start: bytes.length,
      }),
    ).rejects.toMatchObject({ byteSize: bytes.length });
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

  it('resumes a partially persisted archive batch and publishes every asset atomically', async () => {
    const archive = Buffer.from('not-a-real-zip: isolated boundary owns archive validation');
    const first = Buffer.from('solid one\nendsolid one\n');
    const second = Buffer.from('G28\nG1 X1 Y1\n');
    const service = new LocalImportService(database, blobStore, { maximumUploadBytes: 4096 });
    const queued = await service.receive({
      ownerId,
      originalFilename: 'bundle.zip',
      claimedMimeType: 'application/zip',
      modelName: 'Restarted archive',
      source: Readable.from([archive]),
    });
    let attempts = 0;
    const pipeline = new LocalImportPipeline(database, blobStore, {
      inspect: async () => {
        attempts += 1;
        return {
          kind: 'archive' as const,
          originalDetection: detection('archive', 'application/zip'),
          files: [
            prepared('models/one.stl', first, detection('stl', 'model/stl')),
            {
              ...prepared('jobs/one.gcode', second, detection('gcode', 'text/x-gcode')),
              open:
                attempts === 1
                  ? async () => {
                      throw new Error('simulated worker interruption');
                    }
                  : async () => Readable.from([second]),
            },
          ],
        };
      },
    });

    await expect(pipeline.prepare(queued.id)).rejects.toThrow('simulated worker interruption');
    await expect(pipeline.files(queued.id)).resolves.toHaveLength(2);
    await expect(pipeline.prepare(queued.id)).resolves.toHaveLength(3);
    expect(attempts).toBe(2);
    const archiveJob = required(
      await claimJob(database, {
        workerId: 'archive-worker',
        leaseDurationMs: 10_000,
        types: [localImportJobType],
      }),
      'Expected archive job',
    );
    await handleLocalImportJob(database, service, archiveJob, { pipeline });

    const assets = await database
      .selectFrom('catalogue_assets')
      .select(['role', 'format', 'original_filename'])
      .where('model_id', '=', (await service.get(ownerId, queued.id)).modelId)
      .orderBy('original_filename')
      .execute();
    expect(assets).toEqual([
      { role: 'original_archive', format: 'archive', original_filename: 'bundle.zip' },
      { role: 'gcode', format: 'gcode', original_filename: 'jobs/one.gcode' },
      { role: 'geometry', format: 'stl', original_filename: 'models/one.stl' },
    ]);
  });

  it('persists sanitized failures and cleans extracted objects while retaining the original', async () => {
    const original = Buffer.from('archive bytes');
    const member = Buffer.from('solid retained only until failure');
    const service = new LocalImportService(database, blobStore, { maximumUploadBytes: 4096 });
    const queued = await service.receive({
      ownerId,
      originalFilename: 'hostile.zip',
      claimedMimeType: 'application/zip',
      modelName: 'Rejected archive',
      source: Readable.from([original]),
    });
    const pipeline = new LocalImportPipeline(database, blobStore, {
      inspect: async () => ({
        kind: 'archive',
        originalDetection: detection('archive', 'application/zip'),
        files: [
          prepared('safe.stl', member, detection('stl', 'model/stl')),
          {
            fileKey: 'bad/entry',
            originalFilename: 'bad/entry',
            size: 10,
            checksum: 'a'.repeat(64),
            error: {
              code: 'ARCHIVE\nTRAVERSAL',
              message: 'unsafe\u0000 internal/path',
              retryable: false,
            },
          },
        ],
      }),
    });
    await expect(pipeline.prepare(queued.id)).rejects.toMatchObject({
      code: 'import_batch_failed',
    });
    const preparedFiles = await pipeline.files(queued.id);
    const originalObjectId = required(
      preparedFiles.find((file) => file.isOriginal)?.storedObjectId,
      'Expected retained original',
    );
    const extractedObjectId = required(
      preparedFiles.find((file) => !file.isOriginal && file.status === 'accepted')?.storedObjectId,
      'Expected extracted object',
    );
    const failureJob = required(
      await claimJob(database, {
        workerId: 'failure-worker',
        leaseDurationMs: 10_000,
        types: [localImportJobType],
      }),
      'Expected failure job',
    );
    await handleLocalImportJob(database, service, failureJob, { pipeline });

    const files = await pipeline.files(queued.id);
    expect(files.find((file) => file.status === 'failed')?.error).toEqual({
      code: 'archive_traversal',
      message: 'unsafe internal/path',
      retryable: false,
    });
    const states = await database
      .selectFrom('stored_objects')
      .select(['id', 'state'])
      .where('id', 'in', [originalObjectId, extractedObjectId])
      .orderBy('id')
      .execute();
    expect(states.find((row) => row.id === extractedObjectId)?.state).toBe('pending_delete');
    expect(states.find((row) => row.id === originalObjectId)?.state).toBe('committed');
    expect(
      files.find((file) => !file.isOriginal && file.status === 'accepted')?.storedObjectId,
    ).toBeNull();
    await expect(
      database
        .selectFrom('catalogue_models')
        .select('id')
        .where('name', '=', 'Rejected archive')
        .execute(),
    ).resolves.toHaveLength(0);
  });

  it('persists a sanitized processor-level failure without exposing implementation details', async () => {
    const service = new LocalImportService(database, blobStore, { maximumUploadBytes: 4096 });
    const queued = await service.receive({
      ownerId,
      originalFilename: 'processor-failure.stl',
      claimedMimeType: 'model/stl',
      modelName: 'Processor failure',
      source: Readable.from([Buffer.from('solid failed')]),
    });
    const pipeline = new LocalImportPipeline(database, blobStore, {
      inspect: async () => {
        throw new Error('/private/workspace/parser crashed with secret detail');
      },
    });
    await expect(pipeline.prepare(queued.id)).rejects.toMatchObject({
      code: 'processor_unavailable',
      message: 'The file processor could not complete the request',
      retryable: true,
    });
    const report = await database
      .selectFrom('import_sessions')
      .select('processing_report')
      .where('id', '=', queued.id)
      .executeTakeFirstOrThrow();
    expect(report.processing_report).toEqual({
      kind: 'processor_failure',
      failure: {
        code: 'processor_unavailable',
        message: 'The file processor could not complete the request',
        retryable: true,
      },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const processorJob = required(
        await claimJob(database, {
          workerId: 'processor-failure-worker',
          leaseDurationMs: 10_000,
          types: [localImportJobType],
          now: new Date(Date.now() + 60_000),
        }),
        'Expected processor failure job',
      );
      await handleLocalImportJob(database, service, processorJob, {
        pipeline,
        retryPolicy: { baseDelayMs: 1, maximumDelayMs: 1 },
      });
    }
  });

  it('pauses for an explicit owner-scoped duplicate keep decision and resumes the same job', async () => {
    const bytes = Buffer.from('solid duplicate\nendsolid duplicate\n');
    const baseline = new LocalImportService(database, blobStore, { maximumUploadBytes: 4096 });
    await baseline.receive({
      ownerId,
      originalFilename: 'first.stl',
      claimedMimeType: 'model/stl',
      modelName: 'Duplicate source',
      source: Readable.from([bytes]),
    });
    const baselineJob = required(
      await claimJob(database, {
        workerId: 'duplicate-baseline-worker',
        leaseDurationMs: 10_000,
        types: [localImportJobType],
      }),
      'Expected duplicate baseline job',
    );
    await handleLocalImportJob(database, baseline, baselineJob);

    const service = new LocalImportService(database, blobStore, { maximumUploadBytes: 4096 });
    const queued = await service.receive({
      ownerId,
      originalFilename: 'copy.stl',
      claimedMimeType: 'model/stl',
      modelName: 'Duplicate kept',
      source: Readable.from([bytes]),
    });
    const pipeline = new LocalImportPipeline(database, blobStore, {
      inspect: async () => ({
        kind: 'file',
        originalDetection: detection('stl', 'model/stl'),
        files: [],
      }),
    });
    const job = required(
      await claimJob(database, {
        workerId: 'duplicate-worker',
        leaseDurationMs: 10_000,
        types: [localImportJobType],
      }),
      'Expected duplicate job',
    );
    await handleLocalImportJob(database, service, job, { pipeline });
    const pausedJob = await database
      .selectFrom('jobs')
      .select(['state', 'attempts', 'last_error_code'])
      .where('id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(pausedJob).toMatchObject({
      state: 'dead_letter',
      last_error_code: 'duplicate_decision_required',
    });
    const decision = await pipeline.files(queued.id);
    const duplicateFile = required(
      decision.find((file) => file.duplicateDecision === 'required'),
      'Expected duplicate decision',
    );
    await pipeline.keepExactDuplicates(queued.id, [duplicateFile.id]);
    await expect(
      database
        .selectFrom('jobs')
        .select(['state', 'attempts'])
        .where('id', '=', job.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: 'queued', attempts: 0 });
    const resumed = required(
      await claimJob(database, {
        workerId: 'duplicate-worker',
        leaseDurationMs: 10_000,
        types: [localImportJobType],
      }),
      'Expected resumed job',
    );
    await handleLocalImportJob(database, service, resumed, { pipeline });
    await expect(service.get(ownerId, queued.id)).resolves.toMatchObject({ state: 'succeeded' });
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
    ).resolves.toEqual({ state: 'committed' });
  });

  it('rolls migration 0005 down independently', async () => {
    await applyMigration(database, '0009_import_processing.down.sql');
    await applyMigration(database, '0005_import_sessions.down.sql');
    const relation = await sql<{
      relation: string | null;
    }>`select to_regclass('import_sessions')::text as relation`.execute(database);
    expect(relation.rows[0]?.relation).toBeNull();
    await applyMigration(database, '0005_import_sessions.up.sql');
    await applyMigration(database, '0009_import_processing.up.sql');
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

function checksum(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function detection(format: 'stl' | 'gcode' | 'archive', mimeType: string) {
  return { format, mimeType, confidence: 'signature' as const, metadata: {}, warnings: [] };
}

function prepared(fileKey: string, bytes: Buffer, facts: ReturnType<typeof detection>) {
  return {
    fileKey,
    originalFilename: fileKey,
    size: bytes.length,
    checksum: checksum(bytes),
    detection: facts,
    open: async () => Readable.from([bytes]),
  };
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
