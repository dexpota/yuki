import { readFile } from 'node:fs/promises';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type CatalogueDatabaseSchema, CatalogueService } from '../../../src/catalogue/index.js';
import {
  CataloguePreviewService,
  type PreviewDatabaseSchema,
} from '../../../src/catalogue/previews/index.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../../src/platform/database/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('catalogue generated artifacts', () => {
  let database: Database<PreviewDatabaseSchema>;
  let previews: CataloguePreviewService;
  const schemaName = `c05_${process.pid}_${Date.now()}`;
  const ownerId = '15000000-0000-4000-8000-000000000001';
  const sourceObjectId = '45000000-0000-4000-8000-000000000001';
  const modelId = '25000000-0000-4000-8000-000000000001';
  const assetId = '55000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    const setup = createDatabase<PreviewDatabaseSchema>(
      configuration(databaseUrl as string, 'c05-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<PreviewDatabaseSchema>(configuration(url.toString(), 'c05-test'));
    await migrate(database, '0001_durable_jobs.up.sql');
    await migrate(database, '0002_storage_objects.up.sql');
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerId})`.execute(database);
    await migrate(database, '0004_catalogue.up.sql');
    await migrate(database, '0010_catalogue_previews.up.sql');
    await registerObject(sourceObjectId, 'source/stl', 84, 'a'.repeat(64));
    await new CatalogueService(
      database as unknown as Database<CatalogueDatabaseSchema>,
    ).createModel(ownerId, {
      id: modelId,
      name: 'Preview cube',
      importSource: 'upload',
      initialVersion: {
        id: '35000000-0000-4000-8000-000000000001',
        label: 'v1',
        metadataSnapshot: {},
        assets: [
          {
            id: assetId,
            storedObjectId: sourceObjectId,
            role: 'geometry',
            format: 'stl',
            originalFilename: 'cube.stl',
            detectedMimeType: 'model/stl',
            byteSize: 84,
            checksum: 'a'.repeat(64),
          },
        ],
      },
    });
    previews = new CataloguePreviewService(database);
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<PreviewDatabaseSchema>(
      configuration(databaseUrl as string, 'c05-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('publishes all outputs atomically, reference counted, and retry safe', async () => {
    const geometry = await previews.request(ownerId, identity('geometry_preview'));
    const thumbnail = await previews.request(ownerId, identity('thumbnail'));
    await previews.start(ownerId, geometry.id);
    await previews.start(ownerId, thumbnail.id);
    const outputs = [
      ready(geometry.id, '65000000-0000-4000-8000-000000000001', 'preview.glb'),
      ready(thumbnail.id, '65000000-0000-4000-8000-000000000002', 'thumbnail.svg'),
    ] as const;
    await previews.readyBatch(ownerId, outputs);
    await previews.readyBatch(ownerId, outputs);
    expect((await previews.forAsset(ownerId, assetId)).map((artifact) => artifact.status)).toEqual([
      'ready',
      'ready',
    ]);
    const references = await database
      .selectFrom('stored_objects')
      .select(['id', 'reference_count'])
      .where(
        'id',
        'in',
        outputs.map((output) => output.storedObjectId),
      )
      .orderBy('id')
      .execute();
    expect(references.map((row) => row.reference_count)).toEqual([1, 1]);
  });

  function identity(kind: 'geometry_preview' | 'thumbnail') {
    return { sourceAssetId: assetId, kind, generator: 'test', generatorVersion: '1' } as const;
  }

  function ready(artifactId: string, storedObjectId: string, objectKey: string) {
    return {
      artifactId,
      storedObjectId,
      backend: 'local',
      objectKey,
      checksum: 'b'.repeat(64),
      mimeType: objectKey.endsWith('.glb') ? 'model/gltf-binary' : 'image/svg+xml',
      byteSize: 20,
    };
  }

  async function registerObject(id: string, key: string, size: number, checksum: string) {
    await database
      .insertInto('stored_objects')
      .values({
        id,
        backend: 'local',
        object_key: key,
        checksum,
        byte_size: size,
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

async function migrate(database: Database<PreviewDatabaseSchema>, filename: string) {
  await sql
    .raw(await readFile(new URL(`../../../migrations/${filename}`, import.meta.url), 'utf8'))
    .execute(database);
}

function configuration(connectionString: string, applicationName: string) {
  return {
    connectionString,
    maximumPoolSize: 2,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: 10_000,
    applicationName,
  };
}
