import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type CatalogueDatabaseSchema, CatalogueService } from '../../../src/catalogue/index.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../../src/platform/database/index.js';
import type { BlobStore } from '../../../src/platform/storage/index.js';
import { normalizePrinterProfile } from '../../../src/printing/printers/public.js';
import { type QueueDatabaseSchema, QueueService } from '../../../src/printing/queue/index.js';
import {
  type PrintCommandGateway,
  PrintCommandGatewayError,
  PrintStartCommandService,
  PrintStartConflictError,
  type PrintStartDatabaseSchema,
  PrintStartService,
  processNextPrintStartJob,
} from '../../../src/printing/start/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('confirmed remote print start', () => {
  let database: Database<PrintStartDatabaseSchema>;
  let queue: QueueService;
  const schemaName = `p06_${process.pid}_${Date.now()}`;
  const ownerId = uuid(1);
  const modelId = uuid(2);
  const versionId = uuid(3);
  const printerId = uuid(4);
  const assetId = uuid(5);
  const objectId = uuid(6);

  beforeAll(async () => {
    const setup = createDatabase<PrintStartDatabaseSchema>(
      configuration(databaseUrl as string, 'p06-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<PrintStartDatabaseSchema>(configuration(url.toString(), 'p06-test'));
    await migrate(database, '0001_durable_jobs.up.sql');
    await migrate(database, '0002_storage_objects.up.sql');
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerId})`.execute(database);
    await migrate(database, '0004_catalogue.up.sql');
    await migrate(database, '0008_printers.up.sql');
    await migrate(database, '0013_printing_compatibility.up.sql');
    await migrate(database, '0014_print_queue.up.sql');
    await migrate(database, '0015_print_start.up.sql');
    await migrate(database, '0016_print_history.up.sql');
    await database
      .insertInto('stored_objects')
      .values({
        id: objectId,
        backend: 'local',
        object_key: 'cube.gcode',
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
      name: 'Cube',
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
    queue = new QueueService(database as unknown as Database<QueueDatabaseSchema>);
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<PrintStartDatabaseSchema>(
      configuration(databaseUrl as string, 'p06-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('consumes a fresh safety token once, creates immutable history, and runs the command job', async () => {
    const entry = await queue.request({
      ownerId,
      printerId,
      assetId,
      idempotencyKey: 'queue-cube',
    });
    await queue.completeEvaluation(ownerId, entry.id, facts());
    const second = await queue.request({
      ownerId,
      printerId,
      assetId,
      idempotencyKey: 'queue-cube-second',
    });
    await queue.completeEvaluation(ownerId, second.id, facts());
    const poll = vi.fn(async () => readyMonitoring(printerId));
    const starts = new PrintStartService(database, { poll });
    await expect(starts.issue(ownerId, second.id)).rejects.toThrow(
      'Only the first queued job can be started.',
    );
    const issuedAt = new Date('2026-07-28T12:00:00.000Z');
    const expiringStarts = new PrintStartService(
      database,
      { poll },
      {
        now: () => issuedAt,
        confirmationTtlMs: 1_000,
      },
    );
    const expiredChallenge = await expiringStarts.issue(ownerId, entry.id);
    const expiredStarts = new PrintStartService(
      database,
      { poll },
      {
        now: () => new Date(issuedAt.getTime() + 1_000),
      },
    );
    await expect(expiredStarts.accept(ownerId, entry.id, expiredChallenge.token)).rejects.toThrow(
      'Start confirmation has expired.',
    );

    const challenge = await starts.issue(ownerId, entry.id);
    expect(challenge).toMatchObject({
      printer: { id: printerId, name: 'Workshop' },
      file: { assetId, filename: 'cube.gcode', byteSize: 100 },
      compatibilityStatus: 'compatible',
    });
    expect(challenge.safetyNotice).toContain('cannot verify');

    const accepted = await starts.accept(ownerId, entry.id, challenge.token, 'start-cube');
    await expect(starts.accept(ownerId, entry.id, challenge.token, 'start-cube')).resolves.toEqual(
      accepted,
    );
    await expect(
      starts.accept(ownerId, entry.id, challenge.token, 'different-request'),
    ).rejects.toBeInstanceOf(PrintStartConflictError);
    expect(await queue.list(ownerId, printerId)).toContainEqual(
      expect.objectContaining({
        id: entry.id,
        state: 'uploading',
        position: null,
        printAttemptId: accepted.printAttemptId,
      }),
    );
    expect(await queue.list(ownerId, printerId)).toContainEqual(
      expect.objectContaining({ id: second.id, state: 'queued', position: 0 }),
    );
    expect(
      await database
        .selectFrom('print_attempts')
        .select(['model_snapshot', 'asset_snapshot', 'compatibility_snapshot'])
        .where('id', '=', accepted.printAttemptId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      model_snapshot: { id: modelId, versionId },
      asset_snapshot: { id: assetId, checksum: 'ab'.repeat(32) },
      compatibility_snapshot: { result: { status: 'compatible' } },
    });

    const ensureUploaded = vi.fn(async () => {});
    const start = vi.fn(async () => {
      throw new PrintCommandGatewayError('start', 'timeout', true, true);
    });
    const observe = vi
      .fn()
      .mockResolvedValueOnce(commandFacts({ kind: 'none' }))
      .mockResolvedValueOnce(commandFacts({ kind: 'local', applicationJobId: entry.id }));
    const commands = new PrintStartCommandService(
      database,
      { read: async () => Readable.from(['G1 X1\n']) } as unknown as BlobStore,
      { encrypt: () => '', decrypt: () => 'api-key' },
      {
        validate: async () => ({
          origin: 'http://printer.local',
          baseUrl: 'http://printer.local/',
        }),
      } as never,
      { ensureUploaded, start } satisfies PrintCommandGateway,
      { observe },
    );
    expect(
      await processNextPrintStartJob(database, commands, {
        workerId: 'p06-worker',
        leaseDurationMs: 5_000,
      }),
    ).toBe(true);
    expect(ensureUploaded).toHaveBeenCalledWith(
      expect.anything(),
      'api-key',
      expect.objectContaining({
        path: `yuki/jobs/${entry.id}/cube.gcode`,
        checksum: 'ab'.repeat(32),
      }),
    );
    expect(start).toHaveBeenCalledWith(
      expect.anything(),
      'api-key',
      `yuki/jobs/${entry.id}/cube.gcode`,
    );
    expect(observe).toHaveBeenCalledTimes(2);
    expect(await queue.list(ownerId, printerId)).toContainEqual(
      expect.objectContaining({ id: entry.id, state: 'printing' }),
    );
    expect(
      await database
        .selectFrom('print_attempts')
        .select(['state', 'started_at'])
        .where('id', '=', accepted.printAttemptId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: 'printing', started_at: expect.any(Date) });
  });
});

function commandFacts(
  activeJob:
    | { readonly kind: 'none' }
    | { readonly kind: 'local'; readonly applicationJobId: string },
) {
  return {
    state: 'operational' as const,
    activeJob,
    upstreamFile: { name: null, path: null, origin: null },
    progressPercent: null,
    elapsedSeconds: null,
    remainingSeconds: null,
    temperatures: [],
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

async function migrate(database: Database<PrintStartDatabaseSchema>, filename: string) {
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
