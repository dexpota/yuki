import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type CatalogueDatabaseSchema, CatalogueService } from '../../../src/catalogue/index.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
  loadMigrations,
  migrateUp,
} from '../../../src/platform/database/index.js';
import {
  type PrinterControlDatabaseSchema,
  type PrinterControlGateway,
  PrinterControlCommandService,
  PrinterControlConflictError,
  PrinterControlGatewayError,
  PrinterControlService,
  processNextPrinterControlJob,
} from '../../../src/printing/controls/index.js';
import { normalizePrinterProfile } from '../../../src/printing/printers/public.js';
import { type QueueDatabaseSchema, QueueService } from '../../../src/printing/queue/index.js';
import {
  type PrintStartDatabaseSchema,
  PrintStartService,
} from '../../../src/printing/start/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('confirmed printer controls', () => {
  let database: Database<PrinterControlDatabaseSchema>;
  let queue: QueueService;
  const schemaName = `p07_${process.pid}_${Date.now()}`;
  const ownerId = uuid(1);
  const modelId = uuid(2);
  const versionId = uuid(3);
  const printerId = uuid(4);
  const assetId = uuid(5);
  const objectId = uuid(6);

  beforeAll(async () => {
    const setup = createDatabase<PrinterControlDatabaseSchema>(
      configuration(databaseUrl as string, 'p07-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<PrinterControlDatabaseSchema>(
      configuration(url.toString(), 'p07-test'),
    );
    await migrateUp(
      database,
      await loadMigrations(fileURLToPath(new URL('../../../migrations/', import.meta.url))),
    );
    const now = new Date();
    await sql`
      insert into identity_users (
        id, username, normalized_username, password_hash, created_at, updated_at
      ) values (${ownerId}, 'owner', 'owner', 'hash', ${now}, ${now})
    `.execute(database);
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
        created_at: now,
        updated_at: now,
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
        created_at: now,
        updated_at: now,
        verified_at: now,
        version: 1,
      })
      .executeTakeFirstOrThrow();
    queue = new QueueService(database as unknown as Database<QueueDatabaseSchema>);
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<PrinterControlDatabaseSchema>(
      configuration(databaseUrl as string, 'p07-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('revalidates, durably dispatches, projects pause, and appends audits', async () => {
    const entry = await queue.request({
      ownerId,
      printerId,
      assetId,
      idempotencyKey: 'queue-cube',
    });
    await queue.completeEvaluation(ownerId, entry.id, gcodeFacts());
    const starts = new PrintStartService(
      database as unknown as Database<PrintStartDatabaseSchema>,
      { poll: async () => monitoringView(printerId, entry.id, 'operational') },
    );
    const startChallenge = await starts.issue(ownerId, entry.id);
    const acceptedStart = await starts.accept(ownerId, entry.id, startChallenge.token);
    const now = new Date();
    await database
      .updateTable('printing_queue_entries')
      .set({ state: 'printing', updated_at: now })
      .where('id', '=', entry.id)
      .executeTakeFirstOrThrow();
    await database
      .updateTable('print_attempts')
      .set({ state: 'printing', started_at: now, updated_at: now })
      .where('id', '=', acceptedStart.printAttemptId)
      .executeTakeFirstOrThrow();

    const poll = vi.fn(async () => monitoringView(printerId, entry.id, 'printing'));
    const controls = new PrinterControlService(database, { poll });
    const challenge = await controls.issue(ownerId, printerId, {
      action: 'pause',
      queueEntryId: entry.id,
    });
    expect(challenge).toMatchObject({
      action: 'pause',
      printer: { id: printerId, name: 'Workshop' },
      queueEntryId: entry.id,
    });
    const accepted = await controls.accept(ownerId, printerId, challenge.token, 'pause-once');
    await expect(
      controls.accept(ownerId, printerId, challenge.token, 'pause-once'),
    ).resolves.toEqual(accepted);
    expect(poll).toHaveBeenCalledTimes(2);

    const execute = vi.fn(async () => {});
    const commands = new PrinterControlCommandService(
      database,
      { encrypt: () => '', decrypt: () => 'api-key' },
      {
        validate: async () => ({
          origin: 'http://printer.local',
          baseUrl: 'http://printer.local/',
        }),
      } as never,
      { execute } satisfies PrinterControlGateway,
      { observe: async () => commandFacts(entry.id, 'printing') },
    );
    expect(
      await processNextPrinterControlJob(database, commands, {
        workerId: 'p07-worker',
        leaseDurationMs: 5_000,
      }),
    ).toBe(true);
    expect(execute).toHaveBeenCalledWith(expect.anything(), 'api-key', 'pause', {});
    expect(await queue.list(ownerId, printerId)).toContainEqual(
      expect.objectContaining({ id: entry.id, state: 'paused' }),
    );
    expect(
      await database
        .selectFrom('print_attempts')
        .select('state')
        .where('id', '=', acceptedStart.printAttemptId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'paused' });
    expect(
      await database
        .selectFrom('printer_control_events')
        .select(['outcome', 'action'])
        .where('command_id', '=', accepted.commandId)
        .orderBy('id')
        .execute(),
    ).toEqual([
      { outcome: 'accepted', action: 'pause' },
      { outcome: 'completed', action: 'pause' },
    ]);
    expect(
      await database
        .selectFrom('print_attempt_events')
        .select('kind')
        .where('print_attempt_id', '=', acceptedStart.printAttemptId)
        .orderBy('id')
        .execute(),
    ).toContainEqual({ kind: 'paused' });

    const resumeControls = new PrinterControlService(database, {
      poll: async () => monitoringView(printerId, entry.id, 'paused'),
    });
    const resumeChallenge = await resumeControls.issue(ownerId, printerId, {
      action: 'resume',
      queueEntryId: entry.id,
    });
    await resumeControls.accept(ownerId, printerId, resumeChallenge.token);
    const resumeCommands = new PrinterControlCommandService(
      database,
      { encrypt: () => '', decrypt: () => 'api-key' },
      {
        validate: async () => ({
          origin: 'http://printer.local',
          baseUrl: 'http://printer.local/',
        }),
      } as never,
      {
        execute: async () => {
          throw new PrinterControlGatewayError('timeout', true);
        },
      },
      {
        observe: vi
          .fn()
          .mockResolvedValueOnce(commandFacts(entry.id, 'paused'))
          .mockResolvedValueOnce(commandFacts(entry.id, 'printing')),
      },
    );
    expect(
      await processNextPrinterControlJob(database, resumeCommands, {
        workerId: 'p07-worker',
        leaseDurationMs: 5_000,
      }),
    ).toBe(true);
    expect(await queue.list(ownerId, printerId)).toContainEqual(
      expect.objectContaining({ id: entry.id, state: 'printing' }),
    );

    const cancelControls = new PrinterControlService(database, {
      poll: async () => monitoringView(printerId, entry.id, 'printing'),
    });
    const cancelChallenge = await cancelControls.issue(ownerId, printerId, {
      action: 'cancel',
      queueEntryId: entry.id,
    });
    await cancelControls.accept(ownerId, printerId, cancelChallenge.token);
    const cancelCommands = new PrinterControlCommandService(
      database,
      { encrypt: () => '', decrypt: () => 'api-key' },
      {
        validate: async () => ({
          origin: 'http://printer.local',
          baseUrl: 'http://printer.local/',
        }),
      } as never,
      { execute: async () => {} },
      { observe: async () => commandFacts(entry.id, 'printing') },
    );
    expect(
      await processNextPrinterControlJob(database, cancelCommands, {
        workerId: 'p07-worker',
        leaseDurationMs: 5_000,
      }),
    ).toBe(true);
    expect(await queue.list(ownerId, printerId)).toContainEqual(
      expect.objectContaining({ id: entry.id, state: 'cancelled' }),
    );
    expect(
      await database
        .selectFrom('print_attempts')
        .select(['state', 'outcome', 'completed_at'])
        .where('id', '=', acceptedStart.printAttemptId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      state: 'cancelled',
      outcome: 'cancelled',
      completed_at: expect.any(Date),
    });
  });

  it('rejects unsafe targets and stale or mismatched job state', async () => {
    const controls = new PrinterControlService(database, {
      poll: async () => ({
        ...monitoringView(printerId, uuid(99), 'printing'),
        stale: true,
      }),
    });
    await expect(
      controls.issue(ownerId, printerId, {
        action: 'set_tool_temperature',
        tool: 'tool0',
        targetCelsius: 301,
      }),
    ).rejects.toThrow('between 0 and 300');
    await expect(
      controls.issue(ownerId, printerId, {
        action: 'pause',
        queueEntryId: uuid(99),
      }),
    ).rejects.toBeInstanceOf(PrinterControlConflictError);
  });
});

function commandFacts(queueEntryId: string, state: 'printing' | 'paused') {
  return {
    state,
    activeJob: { kind: 'local' as const, applicationJobId: queueEntryId },
    upstreamFile: { name: null, path: null, origin: null },
    progressPercent: null,
    elapsedSeconds: null,
    remainingSeconds: null,
    temperatures: [],
  };
}

function monitoringView(
  printerId: string,
  queueEntryId: string,
  state: 'operational' | 'printing' | 'paused',
) {
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
      operationalState: state,
      activeJob:
        state === 'operational'
          ? {
              kind: 'none' as const,
              applicationJobId: null,
              upstreamFileName: null,
              upstreamFilePath: null,
              upstreamFileOrigin: null,
            }
          : {
              kind: 'local' as const,
              applicationJobId: queueEntryId,
              upstreamFileName: 'cube.gcode',
              upstreamFilePath: `yuki/jobs/${queueEntryId}/cube.gcode`,
              upstreamFileOrigin: 'local',
            },
      progressPercent: null,
      elapsedSeconds: null,
      remainingSeconds: null,
      temperatures: [
        { component: 'tool0', actualCelsius: 200, targetCelsius: 205 },
        { component: 'bed', actualCelsius: 60, targetCelsius: 60 },
      ],
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

function gcodeFacts() {
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
