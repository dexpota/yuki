import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createDatabase,
  type Database,
  loadMigrations,
  migrateUp,
} from '../../../src/platform/database/index.js';
import {
  type NotificationDatabaseSchema,
  NotificationService,
} from '../../../src/printing/notifications/index.js';
import { normalizePrinterProfile } from '../../../src/printing/printers/public.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('transactional notifications', () => {
  let database: Database<NotificationDatabaseSchema>;
  let service: NotificationService;
  const schemaName = `n01_${process.pid}_${Date.now()}`;
  const ownerId = uuid(1);
  const printerId = uuid(2);
  const attemptId = uuid(3);

  beforeAll(async () => {
    const setup = createDatabase<NotificationDatabaseSchema>(
      configuration(databaseUrl as string, 'n01-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<NotificationDatabaseSchema>(
      configuration(url.toString(), 'n01-test'),
    );
    await migrateUp(
      database,
      await loadMigrations(fileURLToPath(new URL('../../../migrations/', import.meta.url))),
    );
    const now = new Date('2026-07-28T08:00:00.000Z');
    await sql`
      insert into identity_users (
        id, username, normalized_username, password_hash, created_at, updated_at
      ) values (${ownerId}, 'owner', 'owner', 'hash', ${now}, ${now})
    `.execute(database);
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
        operational_state: 'printing',
        profile_schema_version: 1,
        profile: normalizePrinterProfile({
          buildVolume: {
            shape: 'rectangular',
            origin: 'lowerleft',
            widthMm: 220,
            depthMm: 220,
            heightMm: 250,
          },
          compatibility: {
            gcodeFlavors: ['marlin'],
            nozzleDiameterMm: 0.4,
            extruderCount: 1,
          },
        }),
        created_at: now,
        updated_at: now,
        verified_at: now,
        version: 1,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto('print_attempts')
      .values({
        id: attemptId,
        owner_id: ownerId,
        queue_entry_id: null,
        printer_id: printerId,
        model_id: null,
        model_version_id: null,
        asset_id: null,
        state: 'starting',
        outcome: null,
        printer_snapshot: { id: printerId, name: 'Workshop' },
        model_snapshot: {},
        asset_snapshot: { filename: 'cube.gcode' },
        compatibility_snapshot: {},
        override_justification: null,
        started_at: null,
        completed_at: null,
        created_at: now,
        updated_at: now,
      })
      .executeTakeFirstOrThrow();
    service = new NotificationService(database, () => new Date('2026-07-28T12:00:00.000Z'));
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<NotificationDatabaseSchema>(
      configuration(databaseUrl as string, 'n01-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('atomically creates one in-app notification and delivery job for a terminal print', async () => {
    const completedAt = new Date('2026-07-28T10:00:00.000Z');
    await expect(
      database.transaction().execute(async (transaction) => {
        await transaction
          .updateTable('print_attempts')
          .set({
            state: 'completed',
            outcome: 'successful',
            completed_at: completedAt,
            updated_at: completedAt,
          })
          .where('id', '=', attemptId)
          .executeTakeFirstOrThrow();
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await service.list(ownerId)).notifications).toHaveLength(0);

    await database
      .updateTable('print_attempts')
      .set({
        state: 'completed',
        outcome: 'successful',
        completed_at: completedAt,
        updated_at: completedAt,
      })
      .where('id', '=', attemptId)
      .executeTakeFirstOrThrow();
    const result = await service.list(ownerId);
    expect(result).toMatchObject({
      unreadCount: 1,
      notifications: [
        expect.objectContaining({
          kind: 'print_completed',
          printAttemptId: attemptId,
          printerId,
          title: 'Print completed',
          message: 'Workshop: cube.gcode',
        }),
      ],
    });
    const notificationId = result.notifications[0]?.id as string;
    expect(
      await database
        .selectFrom('jobs')
        .select(['type', 'payload', 'state', 'idempotency_key'])
        .where('type', '=', 'notification.external.delivery')
        .execute(),
    ).toEqual([
      expect.objectContaining({
        type: 'notification.external.delivery',
        state: 'queued',
        idempotency_key: notificationId,
        payload: { schemaVersion: 1, notificationId, ownerId },
      }),
    ]);

    const read = await service.setRead(ownerId, notificationId, true, 1);
    expect(read).toMatchObject({ readAt: new Date('2026-07-28T12:00:00.000Z'), version: 2 });
    expect(await service.markAllRead(ownerId)).toEqual({ updated: 0 });
  });

  it('creates one disconnect notification per online-to-offline job transition', async () => {
    const onlineAt = new Date('2026-07-28T11:00:00.000Z');
    await observation(true, 'external', onlineAt, null);
    await observation(false, 'none', new Date(onlineAt.getTime() + 1_000), 'timeout');
    await observation(false, 'none', new Date(onlineAt.getTime() + 2_000), 'timeout');

    const result = await service.list(ownerId);
    expect(result.notifications.filter((item) => item.kind === 'printer_disconnected')).toEqual([
      expect.objectContaining({
        printerId,
        title: 'Printer disconnected',
        message: 'Workshop disconnected during an active print.',
      }),
    ]);
  });

  it.each([
    ['failed', 'failed', 'print_failed', 'Print failed'],
    ['cancelled', 'cancelled', 'print_cancelled', 'Print cancelled'],
  ] as const)(
    'creates a %s notification for a remotely terminated print',
    async (state, outcome, kind, title) => {
      const id = state === 'failed' ? uuid(4) : uuid(5);
      const now = new Date();
      await database
        .insertInto('print_attempts')
        .values({
          id,
          owner_id: ownerId,
          queue_entry_id: null,
          printer_id: printerId,
          model_id: null,
          model_version_id: null,
          asset_id: null,
          state: 'starting',
          outcome: null,
          printer_snapshot: { id: printerId, name: 'Workshop' },
          model_snapshot: {},
          asset_snapshot: { filename: 'test.gcode' },
          compatibility_snapshot: {},
          override_justification: null,
          started_at: null,
          completed_at: null,
          created_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      await database
        .updateTable('print_attempts')
        .set({ state, outcome, completed_at: now, updated_at: now })
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      expect((await service.list(ownerId)).notifications).toContainEqual(
        expect.objectContaining({ kind, title, printAttemptId: id }),
      );
    },
  );

  async function observation(
    online: boolean,
    activeJobKind: 'none' | 'external',
    observedAt: Date,
    failureKind: 'timeout' | null,
  ) {
    await database
      .insertInto('printer_observations')
      .values({
        owner_id: ownerId,
        printer_id: printerId,
        observed_at: observedAt,
        poll_reason: 'scheduled',
        online,
        operational_state: online ? 'printing' : null,
        active_job_kind: activeJobKind,
        application_job_id: null,
        upstream_file_name: online ? 'external.gcode' : null,
        upstream_file_path: null,
        upstream_file_origin: null,
        progress_percent: online ? 25 : null,
        elapsed_seconds: null,
        remaining_seconds: null,
        temperatures: sql`${JSON.stringify([])}::jsonb`,
        failure_kind: failureKind,
      })
      .executeTakeFirstOrThrow();
  }
});

function configuration(connectionString: string, applicationName: string) {
  return {
    connectionString,
    maximumPoolSize: 3,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: 10_000,
    applicationName,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
