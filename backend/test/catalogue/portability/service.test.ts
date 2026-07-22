import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type CatalogueDatabaseSchema, CatalogueService } from '../../../src/catalogue/index.js';
import {
  type CataloguePortabilityDatabaseSchema,
  CataloguePortabilityOperations,
  CataloguePortabilityService,
  processNextCataloguePortabilityJob,
} from '../../../src/catalogue/portability/index.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../../src/platform/database/index.js';
import { LocalBlobStore } from '../../../src/platform/storage/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('catalogue export and re-import', () => {
  let database: Database<CatalogueDatabaseSchema>;
  let blobs: LocalBlobStore;
  let storageRoot: string;
  const schemaName = `c06_${process.pid}_${Date.now()}`;
  const ownerId = '16000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    const setup = createDatabase<CatalogueDatabaseSchema>(
      configuration(databaseUrl as string, 'c06-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<CatalogueDatabaseSchema>(configuration(url.toString(), 'c06-test'));
    await migrate(database, '0001_durable_jobs.up.sql');
    await migrate(database, '0002_storage_objects.up.sql');
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerId})`.execute(database);
    await migrate(database, '0004_catalogue.up.sql');
    await migrate(database, '0007_catalogue_portability.up.sql');
    storageRoot = join(tmpdir(), `yuki-c06-${process.pid}-${Date.now()}`);
    blobs = await LocalBlobStore.create(storageRoot);
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<CatalogueDatabaseSchema>(
      configuration(databaseUrl as string, 'c06-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  it('round trips versions, originals, metadata, tags and collections with fresh internal identifiers', async () => {
    const first = await register(
      Buffer.from('solid first\nendsolid first\n'),
      '76000000-0000-4000-8000-000000000001',
    );
    const second = await register(
      Buffer.from('solid second\nendsolid second\n'),
      '76000000-0000-4000-8000-000000000002',
    );
    const catalogue = new CatalogueService(database);
    const source = await catalogue.createModel(ownerId, {
      id: '26000000-0000-4000-8000-000000000001',
      name: 'Portable cube',
      description: 'Two versions',
      importSource: 'upload',
      sourceUrl: 'https://example.invalid/cube',
      creator: 'Maker',
      license: 'CC0',
      favorite: true,
      initialVersion: version('36000000-0000-4000-8000-000000000001', first, 'v1'),
    });
    await catalogue.addVersion(
      ownerId,
      source.model.id,
      version('36000000-0000-4000-8000-000000000002', second, 'v2'),
    );
    await catalogue.replaceTags(ownerId, source.model.id, ['Calibration', 'Cube']);
    const collection = await catalogue.createCollection(ownerId, 'Tests', 'Test pieces');
    await catalogue.replaceCollections(ownerId, source.model.id, [collection.id]);

    const portability = new CataloguePortabilityService(database, blobs, {
      storageBackend: 'local',
    });
    const operationDatabase = database as unknown as Database<CataloguePortabilityDatabaseSchema>;
    const operations = new CataloguePortabilityOperations(
      operationDatabase,
      blobs,
      'local',
      20_000_000,
    );
    const queuedExport = await operations.enqueueExport(ownerId, source.model.id, 'export-once');
    expect(queuedExport).toMatchObject({ kind: 'export', state: 'queued', progress: 0 });
    await expect(
      processNextCataloguePortabilityJob(operationDatabase, operations, portability, {
        workerId: 'c06-worker',
        leaseDurationMs: 30_000,
      }),
    ).resolves.toBe(true);
    await expect(operations.get(ownerId, queuedExport.id)).resolves.toMatchObject({
      state: 'succeeded',
      progress: 100,
      downloadReady: true,
    });
    const packageBytes = await collect(
      (await operations.download(ownerId, queuedExport.id)).stream,
    );
    const corrupted = Buffer.from(packageBytes);
    const payloadOffset = corrupted.indexOf('solid first');
    expect(payloadOffset).toBeGreaterThan(0);
    corrupted[payloadOffset] = (corrupted[payloadOffset] as number) ^ 0xff;
    await expect(portability.importModel(ownerId, chunks(corrupted, 13))).rejects.toThrow(
      'invalid',
    );
    await expect(
      database.selectFrom('catalogue_models').select('id').execute(),
    ).resolves.toHaveLength(1);

    const queuedImport = await operations.receiveImport(
      ownerId,
      chunks(packageBytes, 11),
      'import-once',
    );
    expect(queuedImport).toMatchObject({ kind: 'import', state: 'queued' });
    await expect(
      processNextCataloguePortabilityJob(operationDatabase, operations, portability, {
        workerId: 'c06-worker',
        leaseDurationMs: 30_000,
      }),
    ).resolves.toBe(true);
    const imported = await operations.get(ownerId, queuedImport.id);
    expect(imported).toMatchObject({ state: 'succeeded', progress: 100 });
    const result = await catalogue.getModel(ownerId, imported.importedModelId as string);

    expect(imported.importedModelId).not.toBe(source.model.id);
    expect(result.model).toMatchObject({
      name: 'Portable cube',
      description: 'Two versions',
      import_source: 'yuki_export',
      creator: 'Maker',
      license: 'CC0',
      favorite: true,
    });
    expect(result.versions.map((item) => item.label).sort()).toEqual(['v1', 'v2']);
    expect(result.versions.find((item) => item.id === result.model.current_version_id)?.label).toBe(
      'v2',
    );
    expect(result.versions.map((item) => item.metadata_snapshot)).toEqual(
      expect.arrayContaining([{ label: 'v1' }, { label: 'v2' }]),
    );
    expect(result.assets.map((item) => item.checksum).sort()).toEqual(
      [first.checksum, second.checksum].sort(),
    );
    expect(result.tags.map((item) => item.name)).toEqual(['Calibration', 'Cube']);
    expect(result.collections).toEqual([
      { id: expect.any(String), name: 'Tests', description: 'Test pieces' },
    ]);
  });

  async function register(bytes: Buffer, objectId: string) {
    const committed = await blobs.commit(await blobs.stage(chunks(bytes, 4)));
    await database
      .insertInto('stored_objects')
      .values({
        id: objectId,
        backend: 'local',
        object_key: committed.key,
        checksum: committed.checksum,
        byte_size: committed.size,
        state: 'committed',
        reference_count: 0,
        delete_after: null,
        deletion_error: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .executeTakeFirstOrThrow();
    return {
      objectId,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  }
});

function version(
  id: string,
  object: { objectId: string; checksum: string; size: number },
  label: string,
) {
  return {
    id,
    label,
    metadataSnapshot: { label },
    assets: [
      {
        id: id.replace('36000000', '56000000'),
        storedObjectId: object.objectId,
        role: 'geometry' as const,
        format: 'stl' as const,
        originalFilename: `${label}.stl`,
        detectedMimeType: 'model/stl',
        byteSize: object.size,
        checksum: object.checksum,
      },
    ],
  };
}
async function migrate(database: Database<CatalogueDatabaseSchema>, filename: string) {
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
async function* chunks(bytes: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of source) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}
