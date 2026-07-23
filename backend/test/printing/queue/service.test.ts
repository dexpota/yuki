import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type CatalogueDatabaseSchema, CatalogueService } from '../../../src/catalogue/index.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../../src/platform/database/index.js';
import type { BlobStore } from '../../../src/platform/storage/index.js';
import { parseProcessorGcodeFacts } from '../../../src/printing/gcode/index.js';
import { normalizePrinterProfile } from '../../../src/printing/printers/public.js';
import {
  type GcodeFactsProvider,
  processNextQueueEvaluationJob,
  QueueConflictError,
  type QueueDatabaseSchema,
  QueueService,
} from '../../../src/printing/queue/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('persistent per-printer queues', () => {
  let database: Database<QueueDatabaseSchema>;
  let queue: QueueService;
  const schemaName = `p05_${process.pid}_${Date.now()}`;
  const ownerId = uuid(1);
  const modelId = uuid(2);
  const versionId = uuid(3);
  const printerId = uuid(4);
  const firstAssetId = uuid(5);
  const secondAssetId = uuid(6);

  beforeAll(async () => {
    const setup = createDatabase<QueueDatabaseSchema>(
      configuration(databaseUrl as string, 'p05-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<QueueDatabaseSchema>(configuration(url.toString(), 'p05-test'));
    await migrate(database, '0001_durable_jobs.up.sql');
    await migrate(database, '0002_storage_objects.up.sql');
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerId})`.execute(database);
    await migrate(database, '0004_catalogue.up.sql');
    await migrate(database, '0008_printers.up.sql');
    await migrate(database, '0013_printing_compatibility.up.sql');
    await migrate(database, '0014_print_queue.up.sql');
    await registerObject(uuid(7), 'first.gcode', 'ab'.repeat(32));
    await registerObject(uuid(8), 'second.gcode', 'cd'.repeat(32));
    await new CatalogueService(
      database as unknown as Database<CatalogueDatabaseSchema>,
    ).createModel(ownerId, {
      id: modelId,
      name: 'Queued model',
      importSource: 'upload',
      initialVersion: {
        id: versionId,
        label: 'v1',
        metadataSnapshot: {},
        assets: [
          asset(firstAssetId, uuid(7), 'first.gcode', 'ab'.repeat(32)),
          asset(secondAssetId, uuid(8), 'second.gcode', 'cd'.repeat(32)),
        ],
      },
    });
    await database
      .insertInto('printers')
      .values({
        id: printerId,
        owner_id: ownerId,
        display_name: 'Workshop printer',
        octoprint_url: 'http://printer.local',
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
    queue = new QueueService(database);
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<QueueDatabaseSchema>(
      configuration(databaseUrl as string, 'p05-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('evaluates concurrent requests under the printer lock and assigns atomic positions', async () => {
    const first = await queue.request({
      ownerId,
      printerId,
      assetId: firstAssetId,
      idempotencyKey: 'first',
    });
    const replay = await queue.request({
      ownerId,
      printerId,
      assetId: firstAssetId,
      idempotencyKey: 'first',
    });
    expect(replay.id).toBe(first.id);
    const second = await queue.request({
      ownerId,
      printerId,
      assetId: secondAssetId,
      idempotencyKey: 'second',
    });

    const completed = await Promise.all([
      queue.completeEvaluation(ownerId, first.id, facts()),
      queue.completeEvaluation(ownerId, second.id, facts()),
    ]);
    expect(completed.map((entry) => entry.state)).toEqual(['queued', 'queued']);
    expect(new Set(completed.map((entry) => entry.position))).toEqual(new Set([0, 1]));

    const reversed = await queue.reorder(ownerId, printerId, [second.id, first.id]);
    expect(reversed.filter((entry) => entry.state === 'queued').map((entry) => entry.id)).toEqual([
      second.id,
      first.id,
    ]);
    await queue.remove(ownerId, printerId, second.id);
    expect(await queue.list(ownerId, printerId)).toEqual([
      expect.objectContaining({ id: first.id, state: 'queued', position: 0 }),
    ]);
  });

  it('blocks warning and hard-incompatible results with the correct override policy', async () => {
    const warning = await queue.request({
      ownerId,
      printerId,
      assetId: firstAssetId,
      idempotencyKey: 'warning',
    });
    const blockedWarning = await queue.completeEvaluation(
      ownerId,
      warning.id,
      facts({ nozzle: 0.6 }),
    );
    expect(blockedWarning).toMatchObject({
      state: 'blocked',
      compatibilityStatus: 'warning',
    });
    await expect(
      queue.override(ownerId, printerId, warning.id, 'Installed 0.6 mm nozzle'),
    ).resolves.toMatchObject({ state: 'queued', compatibilityStatus: 'warning' });

    const incompatible = await queue.request({
      ownerId,
      printerId,
      assetId: secondAssetId,
      idempotencyKey: 'incompatible',
      overrideJustification: 'Try anyway',
    });
    const blockedHard = await queue.completeEvaluation(
      ownerId,
      incompatible.id,
      facts({ flavor: 'klipper' }),
    );
    expect(blockedHard).toMatchObject({
      state: 'blocked',
      compatibilityStatus: 'incompatible',
      position: null,
    });
    await expect(
      queue.override(ownerId, printerId, incompatible.id, 'Try anyway'),
    ).rejects.toBeInstanceOf(QueueConflictError);
  });

  it('processes durable evaluation jobs through the real queue handler', async () => {
    const entry = await queue.request({
      ownerId,
      printerId,
      assetId: firstAssetId,
      idempotencyKey: 'worker-handler',
    });
    const opened: string[] = [];
    const blobStore = {
      read: async (key: string) => {
        opened.push(key);
        return Readable.from(['G1 X1\n']);
      },
    } as unknown as BlobStore;
    const provider: GcodeFactsProvider = {
      parse: async (input) => {
        await input.open();
        return parseProcessorGcodeFacts(facts());
      },
    };
    while (
      await processNextQueueEvaluationJob(database, blobStore, provider, queue, {
        workerId: 'queue-test-worker',
        leaseDurationMs: 5_000,
      })
    ) {
      // Drain earlier idempotent test jobs as well as the target request.
    }
    expect(opened).toContain('first.gcode');
    expect(await queue.list(ownerId, printerId)).toContainEqual(
      expect.objectContaining({ id: entry.id, state: 'queued' }),
    );
    const job = await database
      .selectFrom('jobs')
      .select('state')
      .where('idempotency_key', '=', entry.id)
      .executeTakeFirstOrThrow();
    expect(job.state).toBe('succeeded');
  });

  async function registerObject(id: string, key: string, checksum: string) {
    await database
      .insertInto('stored_objects')
      .values({
        id,
        backend: 'local',
        object_key: key,
        checksum,
        byte_size: 100,
        state: 'committed',
        reference_count: 1,
        delete_after: null,
        deletion_error: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .executeTakeFirstOrThrow();
  }
});

function asset(id: string, storedObjectId: string, filename: string, checksum: string) {
  return {
    id,
    storedObjectId,
    role: 'gcode' as const,
    format: 'gcode' as const,
    originalFilename: filename,
    detectedMimeType: 'text/x.gcode',
    byteSize: 100,
    checksum,
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

function facts(changes: { readonly flavor?: string; readonly nozzle?: number } = {}) {
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
    targetPrinter: known('Workshop printer'),
    flavor: known(changes.flavor ?? 'marlin'),
    nozzleDiametersMm: known([changes.nozzle ?? 0.4]),
    extruderCount: known(1),
    slicer: { status: 'unknown', reason: 'not-found' },
    statistics: { linesRead: 20, movementSegments: 10 },
  };
}

async function migrate(database: Database<QueueDatabaseSchema>, filename: string) {
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
