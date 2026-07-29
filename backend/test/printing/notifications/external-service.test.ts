import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SecretVault } from '../../../src/identity/index.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
  loadMigrations,
  migrateUp,
} from '../../../src/platform/database/index.js';
import { claimJob } from '../../../src/platform/jobs/index.js';
import {
  ExternalNotificationService,
  handleExternalNotificationJob,
  type NotificationDatabaseSchema,
  NotificationSendError,
  NotificationWebhookDestinationPolicy,
} from '../../../src/printing/notifications/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('external notification delivery', () => {
  let database: Database<NotificationDatabaseSchema>;
  let service: ExternalNotificationService;
  const schemaName = `n02_${process.pid}_${Date.now()}`;
  const ownerId = uuid(1);
  const masterKey = Buffer.alloc(32, 7);

  beforeAll(async () => {
    const setup = createDatabase<NotificationDatabaseSchema>(
      configuration(databaseUrl as string, 'n02-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<NotificationDatabaseSchema>(
      configuration(url.toString(), 'n02-test'),
    );
    await migrateUp(
      database,
      await loadMigrations(fileURLToPath(new URL('../../../migrations/', import.meta.url))),
    );
    const now = new Date('2026-07-29T08:00:00.000Z');
    await sql`
      insert into identity_users (
        id, username, normalized_username, password_hash, created_at, updated_at
      ) values (${ownerId}, 'owner', 'owner', 'hash', ${now}, ${now})
    `.execute(database);
    service = new ExternalNotificationService(
      database,
      new SecretVault(masterKey),
      new NotificationWebhookDestinationPolicy({
        lookupAddresses: async () => ['203.0.113.10'],
      }),
      () => new Date('2026-07-29T09:00:00.000Z'),
    );
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<NotificationDatabaseSchema>(
      configuration(databaseUrl as string, 'n02-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('encrypts configuration, masks secrets and paths, and fences stale updates', async () => {
    expect(await service.configuration(ownerId)).toMatchObject({
      enabled: false,
      configured: false,
      version: 0,
    });
    const saved = await service.updateConfiguration(ownerId, {
      endpointUrl: 'https://hooks.example.test/private/path',
      bearerToken: 'delivery-secret',
      enabled: true,
      expectedVersion: 0,
    });
    expect(saved).toEqual({
      mode: 'webhook',
      enabled: true,
      configured: true,
      endpointDisplay: 'https://hooks.example.test',
      bearerTokenConfigured: true,
      version: 1,
      updatedAt: new Date('2026-07-29T09:00:00.000Z'),
    });
    const stored = await database
      .selectFrom('notification_webhook_configurations')
      .select(['endpoint_origin', 'encrypted_endpoint_url', 'encrypted_bearer_token'])
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow();
    expect(stored.endpoint_origin).toBe('https://hooks.example.test');
    expect(stored.encrypted_endpoint_url).not.toContain('private/path');
    expect(stored.encrypted_bearer_token).not.toContain('delivery-secret');
    expect(await service.resolvedConfiguration(ownerId)).toEqual({
      enabled: true,
      endpointUrl: 'https://hooks.example.test/private/path/',
      bearerToken: 'delivery-secret',
    });
    await expect(
      service.updateConfiguration(ownerId, { enabled: false, expectedVersion: 0 }),
    ).rejects.toThrow('changed by another request');
  });

  it('dead-letters permanent webhook rejection without retrying', async () => {
    const notificationId = await createNotification('print_cancelled', 'Print cancelled');
    const job = await claimJob(database, {
      workerId: 'n02-worker',
      leaseDurationMs: 30_000,
      types: ['notification.external.delivery'],
      now: new Date('2026-07-29T10:30:00.000Z'),
    });
    if (!job) throw new Error('Expected rejected delivery job');
    await handleExternalNotificationJob(
      database,
      service,
      {
        send: async () => {
          throw new NotificationSendError(
            'webhook_rejected',
            'Webhook returned HTTP 401',
            false,
            401,
          );
        },
      },
      job,
    );
    expect(await delivery(notificationId)).toMatchObject({
      state: 'failed',
      attempt_count: 1,
      response_status: 401,
      last_error_code: 'webhook_rejected',
    });
    expect(
      await database.selectFrom('jobs').select('state').where('id', '=', job.id).executeTakeFirst(),
    ).toEqual({ state: 'dead_letter' });
  });

  it('retries transient failures, persists sanitized diagnostics, and then succeeds', async () => {
    const notificationId = await createNotification('print_completed', 'Print completed');
    const firstJob = await claimJob(database, {
      workerId: 'n02-worker',
      leaseDurationMs: 30_000,
      types: ['notification.external.delivery'],
      now: new Date('2026-07-29T10:00:00.000Z'),
    });
    if (!firstJob) throw new Error('Expected notification delivery job');
    const sender = {
      send: vi
        .fn()
        .mockRejectedValueOnce(
          new NotificationSendError(
            'webhook_temporary_response',
            'Webhook returned HTTP 503',
            true,
            503,
          ),
        )
        .mockResolvedValueOnce({ statusCode: 204 }),
    };
    await handleExternalNotificationJob(database, service, sender, firstJob, {
      baseDelayMs: 1_000,
      maximumDelayMs: 1_000,
    });
    expect(await delivery(notificationId)).toMatchObject({
      state: 'retrying',
      attempt_count: 1,
      response_status: 503,
      last_error_code: 'webhook_temporary_response',
      last_error_message: 'Webhook returned HTTP 503',
    });
    const retry = await claimJob(database, {
      workerId: 'n02-worker',
      leaseDurationMs: 30_000,
      types: ['notification.external.delivery'],
      now: new Date('2026-07-29T10:00:02.000Z'),
    });
    if (!retry) throw new Error('Expected retry delivery job');
    await handleExternalNotificationJob(database, service, sender, retry);
    expect(await delivery(notificationId)).toMatchObject({
      state: 'succeeded',
      attempt_count: 2,
      response_status: 204,
      last_error_code: null,
      delivered_at: expect.any(Date),
    });
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.send.mock.calls[0]?.[0]).toMatchObject({
      endpointUrl: 'https://hooks.example.test/private/path/',
      bearerToken: 'delivery-secret',
      notification: {
        schema: 'yuki.notification.v1',
        notificationId,
        kind: 'print_completed',
      },
    });
    expect(await service.deliveries(ownerId)).toContainEqual(
      expect.objectContaining({ notificationId, state: 'succeeded', attemptCount: 2 }),
    );
  });

  it('completes outbox jobs as disabled without invoking the sender', async () => {
    await service.updateConfiguration(ownerId, { enabled: false, expectedVersion: 1 });
    const notificationId = await createNotification('print_failed', 'Print failed');
    const job = await claimJob(database, {
      workerId: 'n02-worker',
      leaseDurationMs: 30_000,
      types: ['notification.external.delivery'],
      now: new Date('2026-07-29T11:00:00.000Z'),
    });
    if (!job) throw new Error('Expected disabled delivery job');
    const sender = { send: vi.fn() };
    await handleExternalNotificationJob(database, service, sender, job);
    expect(sender.send).not.toHaveBeenCalled();
    expect(await delivery(notificationId)).toMatchObject({
      state: 'disabled',
      attempt_count: 0,
      last_error_code: 'channel_disabled',
    });
    expect(
      await database.selectFrom('jobs').select('state').where('id', '=', job.id).executeTakeFirst(),
    ).toEqual({ state: 'succeeded' });
  });

  async function createNotification(kind: string, title: string): Promise<string> {
    const result = await sql<{ readonly id: string }>`
      select printing_create_notification(
        ${ownerId},
        ${kind},
        null,
        null,
        ${title},
        'Workshop: cube.gcode',
        ${JSON.stringify({ schemaVersion: 1 })}::jsonb,
        ${`n02:${kind}:${crypto.randomUUID()}`},
        ${new Date('2026-07-29T10:00:00.000Z')}
      ) as id
    `.execute(database);
    return result.rows[0]?.id as string;
  }

  async function delivery(notificationId: string) {
    return database
      .selectFrom('notification_deliveries')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('notification_id', '=', notificationId)
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
