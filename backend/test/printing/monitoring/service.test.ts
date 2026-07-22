import { readFile } from 'node:fs/promises';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../../src/platform/database/index.js';
import {
  MonitoredPrinterNotFoundError,
  type MonitoringGateway,
  MonitoringGatewayError,
  type PrinterFacts,
  type PrinterMonitoringDatabaseSchema,
  PrinterMonitoringService,
  processNextPrinterPollJob,
  scheduleEnabledPrinterPolls,
} from '../../../src/printing/monitoring/public.js';
import { PrinterDestinationPolicy } from '../../../src/printing/printers/public.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const ownerOne = '10000000-0000-4000-8000-000000000001';
const ownerTwo = '10000000-0000-4000-8000-000000000002';
const printerOne = '80000000-0000-4000-8000-000000000001';
const printerTwo = '80000000-0000-4000-8000-000000000002';
const localJobId = '90000000-0000-4000-8000-000000000001';

integration('durable owner-scoped printer monitoring and recovery', () => {
  let database: Database<PrinterMonitoringDatabaseSchema>;
  const schemaName = `p02_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    const setup = createDatabase<PrinterMonitoringDatabaseSchema>(
      configuration(databaseUrl as string, 'p02-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<PrinterMonitoringDatabaseSchema>(
      configuration(url.toString(), 'p02-test'),
    );
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerOne}), (${ownerTwo})`.execute(
      database,
    );
    await applyMigration(database, '0001_durable_jobs.up.sql');
    await applyMigration(database, '0008_printers.up.sql');
    await applyMigration(database, '0011_printer_monitoring.up.sql');
    await insertPrinter(database, printerOne, ownerOne, true);
    await insertPrinter(database, printerTwo, ownerOne, false);
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<PrinterMonitoringDatabaseSchema>(
      configuration(databaseUrl as string, 'p02-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('preserves last good facts through failure, detects reconnect, and never crosses owners', async () => {
    let now = new Date('2026-07-22T10:00:00Z');
    const observe = vi
      .fn<MonitoringGateway['observe']>()
      .mockResolvedValueOnce(localFacts())
      .mockRejectedValueOnce(new MonitoringGatewayError('timeout', true))
      .mockResolvedValueOnce(externalFacts());
    const service = monitoringService(database, { observe }, () => now, 20_000, 10);

    const first = await service.poll(ownerOne, printerOne, 'startup');
    expect(first).toMatchObject({
      freshness: 'fresh',
      reconciliationState: 'local_job_detected',
      current: { reason: 'startup', activeJob: { kind: 'local', applicationJobId: localJobId } },
    });

    now = new Date('2026-07-22T10:00:30Z');
    await expect(service.get(ownerOne, printerOne)).resolves.toMatchObject({ stale: true });
    const offline = await service.poll(ownerOne, printerOne);
    expect(offline).toMatchObject({
      freshness: 'stale',
      reconciliationState: 'offline',
      consecutiveFailures: 1,
      current: { online: false, failureKind: 'timeout' },
      lastGood: { online: true, activeJob: { kind: 'local' } },
    });
    const printer = await database
      .selectFrom('printers')
      .select(['connection_status', 'operational_state', 'enabled'])
      .where('id', '=', printerOne)
      .executeTakeFirstOrThrow();
    expect(printer).toEqual({
      connection_status: 'offline',
      operational_state: 'printing',
      enabled: true,
    });

    now = new Date('2026-07-22T10:00:31Z');
    const recovered = await service.poll(ownerOne, printerOne);
    expect(recovered).toMatchObject({
      freshness: 'fresh',
      reconciliationState: 'external_job_detected',
      consecutiveFailures: 0,
      current: { reason: 'reconnect', activeJob: { kind: 'external', applicationJobId: null } },
    });

    await expect(service.get(ownerTwo, printerOne)).rejects.toBeInstanceOf(
      MonitoredPrinterNotFoundError,
    );
    await expect(service.history(ownerTwo, printerOne)).rejects.toBeInstanceOf(
      MonitoredPrinterNotFoundError,
    );
  });

  it('bounds history while retaining the latest successful observation across a long outage', async () => {
    let now = new Date('2026-07-22T11:00:00Z');
    const observe = vi
      .fn<MonitoringGateway['observe']>()
      .mockResolvedValueOnce(localFacts())
      .mockRejectedValue(new MonitoringGatewayError('unavailable', true));
    const service = monitoringService(database, { observe }, () => now, 20_000, 2);
    await service.poll(ownerOne, printerOne, 'manual');
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      now = new Date(now.getTime() + 1_000);
      await service.poll(ownerOne, printerOne);
    }
    const rows = await database
      .selectFrom('printer_observations')
      .select(['online'])
      .where('printer_id', '=', printerOne)
      .execute();
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.online)).toHaveLength(1);
    await expect(service.get(ownerOne, printerOne)).resolves.toMatchObject({
      current: { online: false },
      lastGood: { online: true, activeJob: { kind: 'local' } },
    });
  });

  it('durably schedules only enabled printers and deduplicates one startup cycle', async () => {
    const options = {
      reason: 'startup' as const,
      cycleId: 'worker-start-1',
      now: new Date('2026-07-22T12:00:00Z'),
    };
    await expect(scheduleEnabledPrinterPolls(database, options)).resolves.toBe(1);
    await expect(scheduleEnabledPrinterPolls(database, options)).resolves.toBe(1);
    const jobs = await database
      .selectFrom('jobs')
      .select(['id', 'payload', 'idempotency_key'])
      .where('type', '=', 'printing.poll-printer')
      .execute();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      ownerId: ownerOne,
      printerId: printerOne,
      reason: 'startup',
    });
    expect(jobs[0]?.idempotency_key).toContain('worker-start-1');

    const monitoring = monitoringService(
      database,
      { observe: async () => ({ ...externalFacts(), activeJob: { kind: 'ambiguous' } }) },
      () => new Date('2026-07-22T12:00:01Z'),
      20_000,
      10,
    );
    await expect(
      processNextPrinterPollJob(database, monitoring, {
        workerId: 'monitoring-worker',
        leaseDurationMs: 10_000,
        now: new Date('2026-07-22T12:00:01Z'),
      }),
    ).resolves.toBe(true);
    await expect(
      database
        .selectFrom('jobs')
        .select('state')
        .where('id', '=', jobs[0]?.id ?? '')
        .executeTakeFirst(),
    ).resolves.toMatchObject({ state: 'succeeded' });
  });
});

function monitoringService(
  database: Database<PrinterMonitoringDatabaseSchema>,
  gateway: MonitoringGateway,
  now: () => Date,
  staleAfterMs: number,
  historyLimit: number,
) {
  return new PrinterMonitoringService(
    database,
    { encrypt: (value) => value, decrypt: () => 'api-key' },
    new PrinterDestinationPolicy({ lookupAddresses: async () => ['192.168.1.44'] }),
    gateway,
    { now, staleAfterMs, historyLimit },
  );
}

function localFacts(): PrinterFacts {
  return {
    state: 'printing',
    activeJob: { kind: 'local', applicationJobId: localJobId },
    upstreamFile: {
      name: 'part.gcode',
      path: `yuki/jobs/${localJobId}/part.gcode`,
      origin: 'local',
    },
    progressPercent: 25,
    elapsedSeconds: 30,
    remainingSeconds: 90,
    temperatures: [],
  };
}

function externalFacts(): PrinterFacts {
  return {
    ...localFacts(),
    activeJob: { kind: 'external' },
    upstreamFile: { name: 'manual.gcode', path: 'manual.gcode', origin: 'local' },
  };
}

async function insertPrinter(
  database: Database<PrinterMonitoringDatabaseSchema>,
  id: string,
  ownerId: string,
  enabled: boolean,
) {
  const now = new Date('2026-07-22T09:00:00Z');
  await database
    .insertInto('printers')
    .values({
      id,
      owner_id: ownerId,
      display_name: id === printerOne ? 'Workshop' : 'Disabled',
      octoprint_url: 'http://printer.home.arpa:5000/',
      encrypted_api_key: 'encrypted',
      enabled,
      connection_status: 'online',
      operational_state: 'printing',
      profile_schema_version: 1,
      profile: {},
      created_at: now,
      updated_at: now,
      verified_at: now,
      version: 1,
    })
    .executeTakeFirstOrThrow();
}

async function applyMigration(
  database: Database<PrinterMonitoringDatabaseSchema>,
  filename: string,
) {
  const migration = await readFile(
    new URL(`../../../migrations/${filename}`, import.meta.url),
    'utf8',
  );
  await sql.raw(migration).execute(database);
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
