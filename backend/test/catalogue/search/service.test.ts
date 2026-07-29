import { readFile } from 'node:fs/promises';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type CatalogueSearchDatabaseSchema,
  CatalogueSearchRequestError,
  CatalogueSearchService,
} from '../../../src/catalogue/search/index.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../../src/platform/database/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('catalogue indexed search', () => {
  let database: Database<CatalogueSearchDatabaseSchema>;
  let service: CatalogueSearchService;
  const schemaName = `c03_${process.pid}_${Date.now()}`;
  const ownerId = '10000000-0000-4000-8000-000000000001';
  const otherOwnerId = '10000000-0000-4000-8000-000000000002';
  const tagId = '60000000-0000-4000-8000-000000000001';
  const collectionId = '70000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    const setup = createDatabase<CatalogueSearchDatabaseSchema>(
      configuration(databaseUrl as string, 'c03-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);

    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<CatalogueSearchDatabaseSchema>(
      configuration(url.toString(), 'c03-test'),
    );
    await applyMigration(database, '0002_storage_objects.up.sql');
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerId}), (${otherOwnerId})`.execute(
      database,
    );
    await applyMigration(database, '0004_catalogue.up.sql');
    await applyMigration(database, '0006_catalogue_search.up.sql');
    await applyMigration(database, '0010_catalogue_previews.up.sql');
    await seedReferenceData(database, ownerId, otherOwnerId, tagId, collectionId);
    service = new CatalogueSearchService(database);
  }, 30_000);

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<CatalogueSearchDatabaseSchema>(
      configuration(databaseUrl as string, 'c03-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('matches model fields, tags, filenames, and source URLs without crossing owners', async () => {
    for (const query of [
      'singular-description-token',
      'singular-creator-token',
      'singular-source-token',
      'singular-tag-token',
      'singular-filename-token',
    ]) {
      const page = await service.search(ownerId, { query });
      expect(
        page.items.map(({ name }) => name),
        query,
      ).toEqual(['Model 42']);
    }

    const hidden = await service.search(ownerId, { query: 'other-owner-secret' });
    expect(hidden.items).toEqual([]);
    await expect(
      service.search(ownerId, { query: 'singular-description-token' }),
    ).resolves.toMatchObject({
      items: [
        {
          name: 'Model 42',
          thumbnail: {
            status: 'ready',
            downloadUrl: expect.stringContaining('/api/v1/catalogue/previews/'),
          },
        },
      ],
    });
  });

  it('combines every catalogue filter and returns print projections', async () => {
    const page = await service.search(ownerId, {
      tagId,
      collectionId,
      favorite: true,
      assetFormat: 'stl',
      importSource: 'upload',
      printed: true,
      sort: 'printCount',
      direction: 'desc',
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ name: 'Model 42', favorite: true, printCount: 6 });
    expect(page.items[0]?.lastPrintedAt).toEqual(new Date('2026-01-13T00:00:00.000Z'));
  });

  it('uses deterministic opaque keyset cursors across equal and null sort values', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await service.search(ownerId, {
        sort: 'lastPrintedAt',
        direction: 'desc',
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(seen.size).toBe(10_000);
    await expect(
      service.search(ownerId, {
        sort: 'name',
        cursor: Buffer.from(
          JSON.stringify({
            v: 1,
            sort: 'updatedAt',
            direction: 'desc',
            value: '2026-01-01T00:00:00.000Z',
            id: '20000000-0000-4000-8000-000000000001',
          }),
        ).toString('base64url'),
      }),
    ).rejects.toBeInstanceOf(CatalogueSearchRequestError);
  }, 20_000);

  it('orders every supported projection with the stable ID tie-breaker', async () => {
    const cases = [
      { sort: 'name', direction: 'asc', value: (item: SearchItem) => item.name.toLowerCase() },
      {
        sort: 'importedAt',
        direction: 'asc',
        value: (item: SearchItem) => item.createdAt.getTime(),
      },
      {
        sort: 'updatedAt',
        direction: 'desc',
        value: (item: SearchItem) => item.updatedAt.getTime(),
      },
      {
        sort: 'lastPrintedAt',
        direction: 'desc',
        value: (item: SearchItem) => item.lastPrintedAt?.getTime() ?? null,
      },
      { sort: 'printCount', direction: 'desc', value: (item: SearchItem) => item.printCount },
    ] as const;

    for (const testCase of cases) {
      const page = await service.search(ownerId, {
        sort: testCase.sort,
        direction: testCase.direction,
        limit: 100,
      });
      for (let index = 1; index < page.items.length; index += 1) {
        const previous = page.items[index - 1];
        const current = page.items[index];
        if (!previous || !current) continue;
        const left = testCase.value(previous);
        const right = testCase.value(current);
        if (left === right) expect(previous.id.localeCompare(current.id)).toBeLessThan(0);
        else if (left === null) expect(right).toBeNull();
        else if (right !== null)
          expect(testCase.direction === 'asc' ? left <= right : left >= right).toBe(true);
      }
    }
  });

  it('uses the GIN search index within a stable planner-cost budget', async () => {
    const explanation = await database.transaction().execute(async (transaction) => {
      // A 10k-row fixture can still make a cached in-memory sequential scan look cheaper.
      // Disabling it proves that the indexed access path is valid without using wall time.
      await sql`set local enable_seqscan = off`.execute(transaction);
      return sql<{ readonly 'QUERY PLAN': unknown }>`
        explain (format json, costs true)
        select id
        from catalogue_models
        where owner_id = ${ownerId}
          and search_document @@ plainto_tsquery('simple', 'singular description token')
      `.execute(transaction);
    });
    const serialized = JSON.stringify(explanation.rows);
    const parsed = explanation.rows[0]?.['QUERY PLAN'] as
      | readonly [{ readonly Plan?: { readonly 'Total Cost'?: number } }]
      | undefined;

    expect(serialized).toContain('catalogue_models_search_document_idx');
    expect(parsed?.[0]?.Plan?.['Total Cost']).toBeLessThan(1_000);
  });

  it('rolls the additive search migration back without changing catalogue data', async () => {
    await applyMigration(database, '0006_catalogue_search.down.sql');
    const column = await sql<{ readonly count: string }>`
      select count(*)::text as count
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'catalogue_models'
        and column_name = 'search_document'
    `.execute(database);
    const models = await sql<{ readonly count: string }>`
      select count(*)::text as count from catalogue_models
    `.execute(database);

    expect(column.rows[0]?.count).toBe('0');
    expect(models.rows[0]?.count).toBe('10001');
  });
});

type SearchItem = Awaited<ReturnType<CatalogueSearchService['search']>>['items'][number];

async function seedReferenceData(
  database: Database<CatalogueSearchDatabaseSchema>,
  ownerId: string,
  otherOwnerId: string,
  tagId: string,
  collectionId: string,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await sql`
      insert into stored_objects (
        id, backend, object_key, checksum, byte_size, state, reference_count, created_at, updated_at
      )
      select
        md5('object-' || g)::uuid, 'local', 'objects/' || g, repeat('a', 64), 12,
        'committed', 0, timestamptz '2026-01-01', timestamptz '2026-01-01'
      from generate_series(1, 10001) g
    `.execute(transaction);
    await sql`
      insert into catalogue_models (
        id, owner_id, name, description, import_source, source_url, creator, license,
        favorite, current_version_id, cover_asset_id, print_count, last_printed_at,
        created_at, updated_at
      )
      select
        md5('model-' || g)::uuid,
        case when g = 10001 then ${otherOwnerId}::uuid else ${ownerId}::uuid end,
        case when g = 10001 then 'other-owner-secret' else 'Model ' || g end,
        case when g = 42 then 'singular-description-token' else 'Printable library item' end,
        case when g % 2 = 0 then 'upload' else 'yuki_export' end,
        case when g = 42 then 'https://example.test/singular-source-token' else null end,
        case when g = 42 then 'singular-creator-token' else null end,
        null,
        g = 42,
        md5('version-' || g)::uuid,
        null,
        g % 9,
        case when g % 3 = 0 then timestamptz '2026-01-01' + (g % 30) * interval '1 day' else null end,
        timestamptz '2025-01-01' + g * interval '1 minute',
        timestamptz '2026-01-01' + (g % 20) * interval '1 day'
      from generate_series(1, 10001) g
    `.execute(transaction);
    await sql`
      insert into catalogue_model_versions (
        id, model_id, label, change_note, metadata_schema_version, metadata_snapshot,
        created_at, published_at
      )
      select
        md5('version-' || g)::uuid, md5('model-' || g)::uuid, 'v1', null, 1, '{}'::jsonb,
        timestamptz '2025-01-01', null
      from generate_series(1, 10001) g
    `.execute(transaction);
    await sql`
      insert into catalogue_assets (
        id, model_id, model_version_id, stored_object_id, role, format,
        original_filename, detected_mime_type, byte_size, checksum, imported_at, published_at
      )
      select
        md5('asset-' || g)::uuid, md5('model-' || g)::uuid, md5('version-' || g)::uuid,
        md5('object-' || g)::uuid, 'geometry', case when g % 2 = 0 then 'stl' else 'obj' end,
        case when g = 42 then 'singular-filename-token.stl' else 'model-' || g || '.stl' end,
        'model/stl', 12, repeat('a', 64), timestamptz '2025-01-01', timestamptz '2025-01-01'
      from generate_series(1, 10001) g
    `.execute(transaction);
    await sql`
      update catalogue_model_versions
      set published_at = timestamptz '2025-01-01'
    `.execute(transaction);
    await sql`
      insert into stored_objects (
        id, backend, object_key, checksum, byte_size, state, reference_count,
        created_at, updated_at
      ) values (
        md5('thumbnail-object-42')::uuid, 'local', 'thumbnails/model-42.svg',
        repeat('b', 64), 12, 'committed', 1,
        timestamptz '2025-01-01', timestamptz '2025-01-01'
      )
    `.execute(transaction);
    await sql`
      insert into catalogue_generated_artifacts (
        id, owner_id, source_asset_id, kind, status, generator, generator_version,
        stored_object_id, mime_type, byte_size, dimensions, summary, failure_code,
        failure_message, attempt, created_at, updated_at, completed_at
      ) values (
        md5('thumbnail-artifact-42')::uuid, ${ownerId}, md5('asset-42')::uuid,
        'thumbnail', 'ready', 'yuki-preview', '1',
        md5('thumbnail-object-42')::uuid, 'image/svg+xml', 12, null, null, null,
        null, 1, timestamptz '2025-01-01', timestamptz '2025-01-01',
        timestamptz '2025-01-01'
      )
    `.execute(transaction);
    await sql`
      insert into stored_object_references (
        stored_object_id, owner_type, owner_id, created_at
      ) values (
        md5('thumbnail-object-42')::uuid, 'catalogue_generated_artifact',
        md5('thumbnail-artifact-42')::uuid, timestamptz '2025-01-01'
      )
    `.execute(transaction);
    await sql`
      insert into catalogue_tags (id, owner_id, name, normalized_name, created_at)
      values (${tagId}, ${ownerId}, 'singular-tag-token', 'singular-tag-token', timestamptz '2025-01-01')
    `.execute(transaction);
    await sql`
      insert into catalogue_collections (id, owner_id, name, normalized_name, description, created_at, updated_at)
      values (${collectionId}, ${ownerId}, 'Selected', 'selected', '', timestamptz '2025-01-01', timestamptz '2025-01-01')
    `.execute(transaction);
    await sql`
      insert into catalogue_model_tags (model_id, tag_id, owner_id, created_at)
      values (md5('model-42')::uuid, ${tagId}, ${ownerId}, timestamptz '2025-01-01')
    `.execute(transaction);
    await sql`
      insert into catalogue_model_collections (model_id, collection_id, owner_id, created_at)
      values (md5('model-42')::uuid, ${collectionId}, ${ownerId}, timestamptz '2025-01-01')
    `.execute(transaction);
  });
  await sql`analyze catalogue_models`.execute(database);
  await sql`analyze catalogue_assets`.execute(database);
  await sql`analyze catalogue_tags`.execute(database);
}

async function applyMigration<Schema>(database: Database<Schema>, name: string) {
  const source = await readFile(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
  await sql.raw(source).execute(database);
}

function configuration(connectionString: string, applicationName: string) {
  return {
    connectionString,
    maximumPoolSize: 2,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 5_000,
    statementTimeoutMs: 30_000,
    applicationName,
  };
}
