import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type CatalogueDatabaseSchema, CatalogueService } from '../../../src/catalogue/index.js';
import { CatalogueSearchService } from '../../../src/catalogue/search/index.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../../src/platform/database/index.js';
import { LocalBlobStore } from '../../../src/platform/storage/index.js';
import {
  PrintHistoryConflictError,
  type PrintHistoryDatabaseSchema,
  PrintHistoryService,
} from '../../../src/printing/history/index.js';
import { normalizePrinterProfile } from '../../../src/printing/printers/public.js';
import { type QueueDatabaseSchema, QueueService } from '../../../src/printing/queue/index.js';
import {
  type PrintStartDatabaseSchema,
  PrintStartService,
} from '../../../src/printing/start/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('immutable print history', () => {
  let database: Database<PrintHistoryDatabaseSchema>;
  let history: PrintHistoryService;
  const schemaName = `p09_${process.pid}_${Date.now()}`;
  const storageRoot = join(tmpdir(), schemaName);
  const ownerId = uuid(1);
  const modelId = uuid(2);
  const versionId = uuid(3);
  const printerId = uuid(4);
  const assetId = uuid(5);

  beforeAll(async () => {
    const setup = createDatabase<PrintHistoryDatabaseSchema>(
      configuration(databaseUrl as string, 'p09-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<PrintHistoryDatabaseSchema>(
      configuration(url.toString(), 'p09-test'),
    );
    for (const migration of ['0001_durable_jobs.up.sql', '0002_storage_objects.up.sql'])
      await migrate(database, migration);
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerId})`.execute(database);
    for (const migration of [
      '0004_catalogue.up.sql',
      '0008_printers.up.sql',
      '0011_printer_monitoring.up.sql',
      '0013_printing_compatibility.up.sql',
      '0014_print_queue.up.sql',
      '0015_print_start.up.sql',
      '0016_print_history.up.sql',
    ])
      await migrate(database, migration);
    const objectId = uuid(6);
    await database
      .insertInto('stored_objects')
      .values({
        id: objectId,
        backend: 'local',
        object_key: 'gcode-object',
        checksum: 'ab'.repeat(32),
        byte_size: 100,
        state: 'committed',
        reference_count: 1,
        delete_after: null,
        deletion_error: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .executeTakeFirstOrThrow();
    await new CatalogueService(
      database as unknown as Database<CatalogueDatabaseSchema>,
    ).createModel(ownerId, {
      id: modelId,
      name: 'History cube',
      importSource: 'upload',
      initialVersion: {
        id: versionId,
        label: 'v1',
        metadataSnapshot: {},
        assets: [
          {
            id: assetId,
            storedObjectId: objectId,
            role: 'gcode',
            format: 'gcode',
            originalFilename: 'cube.gcode',
            detectedMimeType: 'text/x.gcode',
            byteSize: 100,
            checksum: 'ab'.repeat(32),
          },
        ],
      },
    });
    await database
      .insertInto('printers')
      .values({
        id: printerId,
        owner_id: ownerId,
        display_name: 'Workshop',
        octoprint_url: 'http://printer.local/',
        encrypted_api_key: 'encrypted',
        enabled: true,
        connection_status: 'online',
        operational_state: 'operational',
        profile_schema_version: 1,
        profile: profile(),
        created_at: new Date(),
        updated_at: new Date(),
        verified_at: new Date(),
        version: 1,
      })
      .executeTakeFirstOrThrow();
    history = new PrintHistoryService(database, await LocalBlobStore.create(storageRoot));
  });

  afterAll(async () => {
    if (database) {
      await migrate(database, '0016_print_history.down.sql');
      await closeDatabase(database);
    }
    const cleanup = createDatabase<PrintHistoryDatabaseSchema>(
      configuration(databaseUrl as string, 'p09-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('records manual attempts, append-only corrections and notes, projections, and photos', async () => {
    const completedAt = new Date(Date.now() - 60_000);
    const input = {
      ownerId,
      modelId,
      modelVersionId: versionId,
      assetId,
      printerId,
      source: 'manual' as const,
      startedAt: new Date(completedAt.getTime() - 3_600_000),
      completedAt,
      outcome: 'successful' as const,
      notes: 'First print',
      idempotencyKey: 'manual-once',
    };
    const attempt = await history.createManual(input);
    expect((await history.createManual(input)).id).toBe(attempt.id);
    await expect(history.createManual({ ...input, outcome: 'failed' })).rejects.toBeInstanceOf(
      PrintHistoryConflictError,
    );
    expect(
      await database
        .selectFrom('catalogue_models')
        .select(['print_count', 'last_printed_at'])
        .where('id', '=', modelId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ print_count: 1, last_printed_at: completedAt });

    await history.correctOutcome(ownerId, attempt.id, 'failed', 'Part detached', 'outcome-once');
    const revised = await history.updateNotes(
      ownerId,
      attempt.id,
      'Part detached near the end',
      'notes-once',
    );
    expect(revised).toMatchObject({ outcome: 'failed', notes: 'Part detached near the end' });
    expect(
      await database
        .selectFrom('print_attempt_outcome_corrections')
        .select(['previous_outcome', 'outcome'])
        .where('print_attempt_id', '=', attempt.id)
        .execute(),
    ).toEqual([{ previous_outcome: 'successful', outcome: 'failed' }]);
    expect(await history.audit(ownerId, attempt.id)).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ kind: 'created' }),
        expect.objectContaining({ kind: 'completed' }),
      ]),
      outcomeCorrections: [expect.objectContaining({ outcome: 'failed' })],
      noteRevisions: expect.arrayContaining([
        expect.objectContaining({ notes: 'Part detached near the end' }),
      ]),
    });
    await expect(
      database
        .updateTable('print_attempt_outcome_corrections')
        .set({ reason: 'rewrite' })
        .where('print_attempt_id', '=', attempt.id)
        .execute(),
    ).rejects.toThrow('append-only');
    await expect(
      database
        .updateTable('print_attempts')
        .set({ model_snapshot: { changed: true } })
        .where('id', '=', attempt.id)
        .execute(),
    ).rejects.toThrow('immutable');

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('photo'),
    ]);
    const photo = await history.addPhoto({
      ownerId,
      attemptId: attempt.id,
      filename: 'result.png',
      declaredMimeType: 'image/png',
      bytes: Readable.from([png]),
      idempotencyKey: 'photo-once',
    });
    expect(photo).toMatchObject({ filename: 'result.png', mimeType: 'image/png' });
    const source = await history.photoSource(ownerId, attempt.id, photo.id);
    expect(Buffer.concat(await source.stream.toArray())).toEqual(png);
    expect(
      await database
        .selectFrom('stored_objects')
        .select('reference_count')
        .where('checksum', '=', photo.checksum)
        .executeTakeFirstOrThrow(),
    ).toEqual({ reference_count: 1 });
    expect(await history.list({ ownerId, modelId })).toContainEqual(
      expect.objectContaining({ id: attempt.id, outcome: 'failed', photos: [photo] }),
    );
    expect(
      await new CatalogueSearchService(
        database as unknown as Database<CatalogueDatabaseSchema>,
      ).search(ownerId, { failed: true }),
    ).toMatchObject({ items: [expect.objectContaining({ id: modelId })] });
  });

  it('closes a remote attempt only after a matching local observation disappears', async () => {
    const queue = new QueueService(database as unknown as Database<QueueDatabaseSchema>);
    const queued = await queue.request({
      ownerId,
      printerId,
      assetId,
      idempotencyKey: 'remote-history',
    });
    await queue.completeEvaluation(ownerId, queued.id, facts());
    const starts = new PrintStartService(
      database as unknown as Database<PrintStartDatabaseSchema>,
      {
        poll: async () => readyMonitoring(printerId),
      },
    );
    const challenge = await starts.issue(ownerId, queued.id);
    const accepted = await starts.accept(ownerId, queued.id, challenge.token, 'remote-start');
    const startedAt = new Date(Date.now() - 30_000);
    await database
      .updateTable('printing_queue_entries')
      .set({ state: 'printing', updated_at: startedAt })
      .where('id', '=', queued.id)
      .executeTakeFirstOrThrow();
    await database
      .updateTable('print_attempts')
      .set({ state: 'printing', started_at: startedAt, updated_at: startedAt })
      .where('id', '=', accepted.printAttemptId)
      .executeTakeFirstOrThrow();
    await observation(queued.id, 'local', startedAt);
    const completedAt = new Date();
    await observation(null, 'none', completedAt);
    await history.observe(
      ownerId,
      printerId,
      {
        state: 'operational',
        activeJob: { kind: 'none' },
        upstreamFile: { name: 'cube.gcode', path: null, origin: 'local' },
        progressPercent: 100,
        elapsedSeconds: 120,
        remainingSeconds: 0,
        temperatures: [],
      },
      completedAt,
    );
    expect(await history.get(ownerId, accepted.printAttemptId)).toMatchObject({
      state: 'completed',
      outcome: 'successful',
      completedAt,
      statistics: { progressPercent: 100, elapsedSeconds: 120 },
    });
    expect(
      await database
        .selectFrom('catalogue_models')
        .select('print_count')
        .where('id', '=', modelId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ print_count: 2 });
    await new CatalogueService(
      database as unknown as Database<CatalogueDatabaseSchema>,
    ).deleteModel(ownerId, modelId);
    expect(await history.get(ownerId, accepted.printAttemptId)).toMatchObject({
      modelId: null,
      modelVersionId: versionId,
      assetId,
      modelSnapshot: { id: modelId, versionId },
    });
  });

  async function observation(
    applicationJobId: string | null,
    kind: 'local' | 'none',
    observedAt: Date,
  ) {
    await database
      .insertInto('printer_observations')
      .values({
        owner_id: ownerId,
        printer_id: printerId,
        observed_at: observedAt,
        poll_reason: 'scheduled',
        online: true,
        operational_state: kind === 'local' ? 'printing' : 'operational',
        active_job_kind: kind,
        application_job_id: applicationJobId,
        upstream_file_name: 'cube.gcode',
        upstream_file_path: applicationJobId ? `yuki/jobs/${applicationJobId}/cube.gcode` : null,
        upstream_file_origin: 'local',
        progress_percent: kind === 'local' ? 50 : 100,
        elapsed_seconds: 60,
        remaining_seconds: kind === 'local' ? 60 : 0,
        temperatures: sql`'[]'::jsonb`,
        failure_kind: null,
      })
      .executeTakeFirstOrThrow();
  }
});

function profile() {
  return normalizePrinterProfile({
    buildVolume: {
      shape: 'rectangular',
      widthMm: 220,
      depthMm: 220,
      heightMm: 250,
      origin: 'lowerleft',
    },
    compatibility: {
      gcodeFlavors: ['marlin'],
      nozzleDiameterMm: 0.4,
      extruderCount: 1,
    },
  });
}

function facts() {
  const evidence = [{ source: 'comment', line: 1, key: 'test' }];
  const known = <T>(value: T) => ({ status: 'known', value, evidence });
  return {
    schemaVersion: 1,
    parser: { name: 'yuki-gcode', version: '1.0.0' },
    buildBounds: known({
      minimum: { x: 0, y: 0, z: 0.2 },
      maximum: { x: 100, y: 100, z: 10.2 },
      size: { width: 100, depth: 100, height: 10 },
      unit: 'mm',
    }),
    targetPrinter: known('Workshop'),
    flavor: known('marlin'),
    nozzleDiametersMm: known([0.4]),
    extruderCount: known(1),
    slicer: { status: 'unknown', reason: 'not-found' },
    statistics: { linesRead: 20, movementSegments: 10 },
  };
}

function readyMonitoring(printerId: string) {
  const now = new Date();
  return {
    printerId,
    freshness: 'fresh' as const,
    stale: false,
    lastAttemptAt: now,
    lastSuccessAt: now,
    lastFailureAt: null,
    consecutiveFailures: 0,
    reconciliationState: 'idle' as const,
    current: {
      id: '1',
      observedAt: now,
      reason: 'manual' as const,
      online: true,
      operationalState: 'operational',
      activeJob: {
        kind: 'none' as const,
        applicationJobId: null,
        upstreamFileName: null,
        upstreamFilePath: null,
        upstreamFileOrigin: null,
      },
      progressPercent: null,
      elapsedSeconds: null,
      remainingSeconds: null,
      temperatures: [],
      failureKind: null,
    },
    lastGood: null,
  };
}

async function migrate(database: Database<PrintHistoryDatabaseSchema>, filename: string) {
  await sql
    .raw(await readFile(new URL(`../../../migrations/${filename}`, import.meta.url), 'utf8'))
    .execute(database);
}

function configuration(connectionString: string, applicationName: string) {
  return {
    connectionString,
    maximumPoolSize: 4,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: 10_000,
    applicationName,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
