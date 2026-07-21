import { readFile } from 'node:fs/promises';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, createDatabase, type Database } from '../../src/platform/database/index.js';
import {
  type ObjectReference,
  type StorageSchema,
  StoredObjectLifecycle,
} from '../../src/platform/storage/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('stored object lifecycle', () => {
  let database: Database<StorageSchema>;
  let lifecycle: StoredObjectLifecycle;
  const schemaName = `f08_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    const setup = createDatabase<StorageSchema>(configuration(databaseUrl as string, 'f08-setup'));
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);

    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<StorageSchema>(configuration(url.toString(), 'f08-test'));
    const migration = await readFile(
      new URL('../../migrations/0002_storage_objects.up.sql', import.meta.url),
      'utf8',
    );
    await sql.raw(migration).execute(database);
    lifecycle = new StoredObjectLifecycle(database);
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<StorageSchema>(
      configuration(databaseUrl as string, 'f08-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('tracks idempotent references and only claims an unreferenced object after retention', async () => {
    const objectId = '11111111-1111-4111-8111-111111111111';
    const reference: ObjectReference = { objectId, ownerType: 'asset', ownerId: 'asset-1' };
    await database.transaction().execute(async (transaction) => {
      await lifecycle.register(transaction, {
        id: objectId,
        backend: 'local',
        key: 'opaque-key',
        checksum: 'a'.repeat(64),
        size: 12,
      });
      await lifecycle.addReference(transaction, reference);
      await lifecycle.addReference(transaction, reference);
    });

    await expect(lifecycle.claimDeletion(new Date('2100-01-01'))).resolves.toBeUndefined();
    await database
      .transaction()
      .execute((transaction) =>
        lifecycle.removeReference(transaction, reference, new Date('2099-01-01')),
      );
    await expect(lifecycle.claimDeletion(new Date('2098-01-01'))).resolves.toBeUndefined();
    await expect(lifecycle.claimDeletion(new Date('2100-01-01'))).resolves.toMatchObject({
      id: objectId,
      key: 'opaque-key',
      size: 12,
    });

    await expect(
      database
        .transaction()
        .execute((transaction) => lifecycle.addReference(transaction, reference)),
    ).rejects.toThrow('deletion is already in progress');
    await lifecycle.completeDeletion(objectId);
    await expect(
      database
        .selectFrom('stored_objects')
        .select('id')
        .where('id', '=', objectId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it('records a sanitized deletion failure and makes it retryable', async () => {
    const objectId = '22222222-2222-4222-8222-222222222222';
    const reference: ObjectReference = { objectId, ownerType: 'asset', ownerId: 'asset-2' };
    await database.transaction().execute(async (transaction) => {
      await lifecycle.register(transaction, {
        id: objectId,
        backend: 'local',
        key: 'retry-key',
        checksum: 'b'.repeat(64),
        size: 7,
      });
      await lifecycle.addReference(transaction, reference);
      await lifecycle.removeReference(transaction, reference, new Date('2020-01-01'));
    });
    await lifecycle.claimDeletion(new Date('2021-01-01'));
    await lifecycle.failDeletion(objectId, new Date('2030-01-01'), 'safe failure');

    await expect(lifecycle.claimDeletion(new Date('2029-01-01'))).resolves.toBeUndefined();
    await expect(lifecycle.claimDeletion(new Date('2031-01-01'))).resolves.toMatchObject({
      id: objectId,
    });
  });
});

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
