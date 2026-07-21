import { readFile } from 'node:fs/promises';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type CatalogueDatabaseSchema,
  CatalogueNotFoundError,
  CatalogueService,
  createCatalogueDeletionPolicy,
} from '../../src/catalogue/index.js';
import { closeDatabase, createDatabase, type Database } from '../../src/platform/database/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('catalogue workflows', () => {
  let database: Database<CatalogueDatabaseSchema>;
  let service: CatalogueService;
  const schemaName = `c02_${process.pid}_${Date.now()}`;
  const ownerId = '11000000-0000-4000-8000-000000000001';
  const otherOwnerId = '11000000-0000-4000-8000-000000000002';
  const objectOneId = '41000000-0000-4000-8000-000000000001';
  const objectTwoId = '41000000-0000-4000-8000-000000000002';
  const now = new Date('2026-07-21T10:00:00.000Z');

  beforeAll(async () => {
    const setup = createDatabase<CatalogueDatabaseSchema>(
      configuration(databaseUrl as string, 'c02-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<CatalogueDatabaseSchema>(configuration(url.toString(), 'c02-test'));
    await applyMigration(database, '0002_storage_objects.up.sql');
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerId}), (${otherOwnerId})`.execute(
      database,
    );
    await applyMigration(database, '0004_catalogue.up.sql');
    await registerObject(database, objectOneId, 'a'.repeat(64), 12);
    await registerObject(database, objectTwoId, 'b'.repeat(64), 24);
    service = new CatalogueService(database, {
      now: () => now,
      deletionPolicy: createCatalogueDeletionPolicy(60_000),
    });
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<CatalogueDatabaseSchema>(
      configuration(databaseUrl as string, 'c02-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('manages one owner model, tags, collections, favorite, and immutable versions', async () => {
    const modelId = '21000000-0000-4000-8000-000000000001';
    const firstVersionId = '31000000-0000-4000-8000-000000000001';
    const secondVersionId = '31000000-0000-4000-8000-000000000002';
    const created = await service.createModel(ownerId, {
      id: modelId,
      name: ' Calibration cube ',
      importSource: 'upload',
      initialVersion: version(firstVersionId, objectOneId, 'v1', 'a'.repeat(64), 12),
    });
    expect(created.model).toMatchObject({
      id: modelId,
      owner_id: ownerId,
      name: 'Calibration cube',
      current_version_id: firstVersionId,
      favorite: false,
    });

    await expect(service.getModel(otherOwnerId, modelId)).rejects.toBeInstanceOf(
      CatalogueNotFoundError,
    );
    await service.updateModel(ownerId, modelId, {
      favorite: true,
      description: 'Small test print',
    });
    const tagged = await service.replaceTags(ownerId, modelId, [
      ' Functional ',
      'functional',
      'Test',
    ]);
    expect(tagged.tags.map((tag) => tag.name)).toEqual(['Functional', 'Test']);

    const collection = await service.createCollection(ownerId, ' Calibration ', 'Test pieces');
    const collected = await service.replaceCollections(ownerId, modelId, [collection.id]);
    expect(collected.collections).toEqual([
      { id: collection.id, name: 'Calibration', description: 'Test pieces' },
    ]);
    await expect(
      service.replaceCollections(otherOwnerId, modelId, [collection.id]),
    ).rejects.toBeInstanceOf(CatalogueNotFoundError);

    const newest = await service.addVersion(
      ownerId,
      modelId,
      version(secondVersionId, objectTwoId, 'v2', 'b'.repeat(64), 24),
    );
    expect(newest.model.current_version_id).toBe(secondVersionId);
    expect(newest.versions).toHaveLength(2);
    const restored = await service.restoreVersion(ownerId, modelId, firstVersionId);
    expect(restored.model.current_version_id).toBe(firstVersionId);
    expect(
      restored.versions.find((entry) => entry.id === firstVersionId)?.published_at,
    ).not.toBeNull();
    await expect(
      database
        .updateTable('catalogue_model_versions')
        .set({ label: 'changed' })
        .where('id', '=', firstVersionId)
        .execute(),
    ).rejects.toThrow('versions are immutable');
  });

  it('deletes only an owned aggregate and schedules its unreferenced objects by policy', async () => {
    const modelId = '21000000-0000-4000-8000-000000000001';
    await expect(service.deleteModel(otherOwnerId, modelId)).rejects.toBeInstanceOf(
      CatalogueNotFoundError,
    );
    const released = await service.deleteModel(ownerId, modelId);
    expect(released).toHaveLength(2);
    await expect(service.getModel(ownerId, modelId)).rejects.toBeInstanceOf(CatalogueNotFoundError);
    const objects = await database
      .selectFrom('stored_objects')
      .select(['id', 'reference_count', 'state', 'delete_after'])
      .orderBy('id')
      .execute();
    expect(objects).toEqual([
      {
        id: objectOneId,
        reference_count: 0,
        state: 'pending_delete',
        delete_after: new Date(now.getTime() + 60_000),
      },
      {
        id: objectTwoId,
        reference_count: 0,
        state: 'pending_delete',
        delete_after: new Date(now.getTime() + 60_000),
      },
    ]);
  });
});

function version(id: string, objectId: string, label: string, checksum: string, byteSize: number) {
  return {
    id,
    label,
    metadataSnapshot: { name: 'Calibration cube' },
    assets: [
      {
        id: id.replace('31000000', '51000000'),
        storedObjectId: objectId,
        role: 'geometry' as const,
        format: 'stl' as const,
        originalFilename: 'cube.stl',
        detectedMimeType: 'model/stl',
        byteSize,
        checksum,
      },
    ],
  };
}

async function registerObject(
  database: Database<CatalogueDatabaseSchema>,
  id: string,
  checksum: string,
  size: number,
) {
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
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
}

async function applyMigration(database: Database<CatalogueDatabaseSchema>, filename: string) {
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
