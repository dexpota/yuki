import { readFile } from 'node:fs/promises';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type CatalogueDatabaseSchema,
  insertDraftAsset,
  insertDraftVersion,
  insertModel,
  normalizeCatalogueName,
  publishVersion,
} from '../../src/catalogue/index.js';
import { closeDatabase, createDatabase, type Database } from '../../src/platform/database/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('catalogue persistence', () => {
  let database: Database<CatalogueDatabaseSchema>;
  const schemaName = `c01_${process.pid}_${Date.now()}`;
  const ownerId = '10000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    const setup = createDatabase<CatalogueDatabaseSchema>(
      configuration(databaseUrl as string, 'c01-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);

    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<CatalogueDatabaseSchema>(configuration(url.toString(), 'c01-test'));
    await applyMigration(database, '0002_storage_objects.up.sql');
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerId})`.execute(database);
    await applyMigration(database, '0004_catalogue.up.sql');
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<CatalogueDatabaseSchema>(
      configuration(databaseUrl as string, 'c01-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('publishes a model atomically and permits duplicate logical assets', async () => {
    const modelId = '20000000-0000-4000-8000-000000000001';
    const versionId = '30000000-0000-4000-8000-000000000001';
    const objectId = '40000000-0000-4000-8000-000000000001';
    await registerObject(database, objectId, 'a'.repeat(64), 12);

    await database.transaction().execute(async (transaction) => {
      const now = new Date('2026-01-01T00:00:00Z');
      await insertModel(transaction, model(modelId, versionId, now));
      await insertDraftVersion(transaction, version(versionId, modelId, 'v1', now));
      await insertDraftAsset(
        transaction,
        asset('50000000-0000-4000-8000-000000000001', modelId, versionId, objectId, now),
      );
      await insertDraftAsset(transaction, {
        ...asset('50000000-0000-4000-8000-000000000002', modelId, versionId, objectId, now),
        original_filename: 'duplicate-copy.stl',
      });
      await publishVersion(transaction, versionId, now);
    });

    await expect(
      database
        .selectFrom('catalogue_assets')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('model_version_id', '=', versionId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: '2' });
    await expect(
      database
        .selectFrom('stored_objects')
        .select('reference_count')
        .where('id', '=', objectId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ reference_count: 2 });
  });

  it('rejects asset metadata that differs from the authoritative stored object', async () => {
    const modelId = '20000000-0000-4000-8000-000000000002';
    const versionId = '30000000-0000-4000-8000-000000000002';
    const objectId = '40000000-0000-4000-8000-000000000002';
    const now = new Date('2026-01-02T00:00:00Z');
    await registerObject(database, objectId, 'b'.repeat(64), 10);

    await expect(
      database.transaction().execute(async (transaction) => {
        await insertModel(transaction, model(modelId, versionId, now));
        await insertDraftVersion(transaction, version(versionId, modelId, 'v1', now));
        await insertDraftAsset(transaction, {
          ...asset('50000000-0000-4000-8000-000000000003', modelId, versionId, objectId, now),
          byte_size: 11,
          checksum: 'c'.repeat(64),
        });
      }),
    ).rejects.toThrow('metadata does not match');
  });

  it('requires the current version to be published before commit', async () => {
    const modelId = '20000000-0000-4000-8000-000000000003';
    const versionId = '30000000-0000-4000-8000-000000000003';
    const now = new Date('2026-01-03T00:00:00Z');

    await expect(
      database.transaction().execute(async (transaction) => {
        await insertModel(transaction, model(modelId, versionId, now));
        await insertDraftVersion(transaction, version(versionId, modelId, 'v1', now));
      }),
    ).rejects.toThrow('current version must be a published version');
  });

  it('seals published versions and assets while allowing current-version restoration', async () => {
    const modelId = '20000000-0000-4000-8000-000000000004';
    const versionOneId = '30000000-0000-4000-8000-000000000004';
    const versionTwoId = '30000000-0000-4000-8000-000000000005';
    const assetOneId = '50000000-0000-4000-8000-000000000004';
    const objectOneId = '40000000-0000-4000-8000-000000000004';
    const objectTwoId = '40000000-0000-4000-8000-000000000005';
    const now = new Date('2026-01-04T00:00:00Z');
    await registerObject(database, objectOneId, 'a'.repeat(64), 12);
    await registerObject(database, objectTwoId, 'a'.repeat(64), 12);

    await database.transaction().execute(async (transaction) => {
      await insertModel(transaction, model(modelId, versionOneId, now));
      await insertDraftVersion(transaction, version(versionOneId, modelId, 'v1', now));
      await insertDraftAsset(
        transaction,
        asset(assetOneId, modelId, versionOneId, objectOneId, now),
      );
      await publishVersion(transaction, versionOneId, now);
    });

    await expect(
      database
        .updateTable('catalogue_model_versions')
        .set({ change_note: 'changed' })
        .where('id', '=', versionOneId)
        .execute(),
    ).rejects.toThrow('versions are immutable');
    await expect(
      database
        .updateTable('catalogue_assets')
        .set({ original_filename: 'changed.stl' })
        .where('id', '=', assetOneId)
        .execute(),
    ).rejects.toThrow('assets are immutable');

    await database.transaction().execute(async (transaction) => {
      await insertDraftVersion(transaction, version(versionTwoId, modelId, 'v2', now));
      await insertDraftAsset(
        transaction,
        asset('50000000-0000-4000-8000-000000000005', modelId, versionTwoId, objectTwoId, now),
      );
      await publishVersion(transaction, versionTwoId, now);
      await transaction
        .updateTable('catalogue_models')
        .set({ current_version_id: versionTwoId, updated_at: now })
        .where('id', '=', modelId)
        .execute();
    });
    await database
      .updateTable('catalogue_models')
      .set({ current_version_id: versionOneId, updated_at: now })
      .where('id', '=', modelId)
      .execute();
    await expect(
      database
        .selectFrom('catalogue_models')
        .select('current_version_id')
        .where('id', '=', modelId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ current_version_id: versionOneId });
  });

  it('normalizes tag names and prevents cross-owner relationships', async () => {
    const otherOwner = '10000000-0000-4000-8000-000000000002';
    await sql`insert into identity_users (id) values (${otherOwner})`.execute(database);
    const tagId = '60000000-0000-4000-8000-000000000001';
    const now = new Date('2026-01-05T00:00:00Z');
    await database
      .insertInto('catalogue_tags')
      .values({
        id: tagId,
        owner_id: otherOwner,
        name: '  Functional  ',
        normalized_name: normalizeCatalogueName('  Functional  '),
        created_at: now,
      })
      .execute();

    await expect(
      database
        .insertInto('catalogue_model_tags')
        .values({
          model_id: '20000000-0000-4000-8000-000000000001',
          tag_id: tagId,
          owner_id: otherOwner,
          created_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });
});

function model(id: string, versionId: string, now: Date) {
  return {
    id,
    owner_id: ownerIdForFixtures,
    name: 'Calibration cube',
    description: '',
    import_source: 'upload' as const,
    source_url: null,
    creator: null,
    license: null,
    favorite: false,
    current_version_id: versionId,
    cover_asset_id: null,
    print_count: 0,
    last_printed_at: null,
    created_at: now,
    updated_at: now,
  };
}

const ownerIdForFixtures = '10000000-0000-4000-8000-000000000001';

function version(id: string, modelId: string, label: string, now: Date) {
  return {
    id,
    model_id: modelId,
    label,
    change_note: null,
    metadata_schema_version: 1,
    metadata_snapshot: { name: 'Calibration cube' },
    created_at: now,
    published_at: null,
  };
}

function asset(id: string, modelId: string, versionId: string, objectId: string, now: Date) {
  return {
    id,
    model_id: modelId,
    model_version_id: versionId,
    stored_object_id: objectId,
    role: 'geometry' as const,
    format: 'stl' as const,
    original_filename: 'cube.stl',
    detected_mime_type: 'model/stl',
    byte_size: 12,
    checksum: 'a'.repeat(64),
    imported_at: now,
    published_at: null,
  };
}

async function registerObject(
  database: Database<CatalogueDatabaseSchema>,
  id: string,
  checksum: string,
  size: number,
) {
  const now = new Date();
  await database
    .insertInto('stored_objects')
    .values({
      id,
      backend: 'local',
      object_key: `objects/${id}`,
      checksum,
      byte_size: size,
      state: 'committed',
      reference_count: 0,
      delete_after: null,
      deletion_error: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function applyMigration(
  database: Database<CatalogueDatabaseSchema>,
  filename: string,
): Promise<void> {
  const migration = await readFile(
    new URL(`../../migrations/${filename}`, import.meta.url),
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
