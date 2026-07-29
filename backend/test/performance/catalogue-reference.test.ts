import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiDatabaseSchema } from '../../src/api-main.js';
import {
  type CatalogueSearchDatabaseSchema,
  registerCatalogueSearchFeature,
} from '../../src/catalogue/search/index.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
  loadMigrations,
  migrateUp,
} from '../../src/platform/database/index.js';
import { createHttpApplication } from '../../src/platform/http/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const ownerId = '90000000-0000-4000-8000-000000000001';
const printerId = '90000000-0000-4000-8000-000000000002';
const twoSecondTargetMs = 2_000;

integration('10,000-model reference performance', () => {
  let application: FastifyInstance;
  let database: Database<ApiDatabaseSchema>;
  let baseUrl: string;
  const schemaName = `o04_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    const setup = createDatabase<ApiDatabaseSchema>(
      configuration(databaseUrl as string, 'o04-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);

    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<ApiDatabaseSchema>(configuration(url.toString(), 'o04-reference'));
    await migrateUp(
      database,
      await loadMigrations(fileURLToPath(new URL('../../migrations/', import.meta.url))),
    );
    await seedReferenceDataset(database);
    application = await createHttpApplication();
    registerCatalogueSearchFeature(application, {
      database: database as unknown as Database<CatalogueSearchDatabaseSchema>,
      identity: {
        requireOwner: async () => undefined,
        ownerForRequest: () => ({
          owner: { id: ownerId, username: 'reference-owner' },
          sessionId: '90000000-0000-4000-8000-000000000003',
        }),
      },
    });
    baseUrl = await application.listen({ host: '127.0.0.1', port: 0 });
  }, 120_000);

  afterAll(async () => {
    if (application) await application.close();
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<ApiDatabaseSchema>(
      configuration(databaseUrl as string, 'o04-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('contains the architectural reference cardinalities', async () => {
    const counts = await sql<{
      readonly models: string;
      readonly versions: string;
      readonly assets: string;
      readonly relationships: string;
      readonly attempts: string;
      readonly thumbnails: string;
    }>`
      select
        (select count(*) from catalogue_models)::text as models,
        (select count(*) from catalogue_model_versions)::text as versions,
        (select count(*) from catalogue_assets)::text as assets,
        (
          (select count(*) from catalogue_model_tags)
          + (select count(*) from catalogue_model_collections)
        )::text as relationships,
        (select count(*) from print_attempts)::text as attempts,
        (
          select count(*) from catalogue_generated_artifacts where kind = 'thumbnail'
        )::text as thumbnails
    `.execute(database);

    expect(counts.rows[0]).toEqual({
      models: '10000',
      versions: '30000',
      assets: '30000',
      relationships: '100000',
      attempts: '5000',
      thumbnails: '8000',
    });
  });

  it('keeps uncached API pages within the two-second target', async () => {
    const tagId = fixtureUuid('tag-20');
    const collectionId = fixtureUuid('collection-20');
    const deepCursor = Buffer.from(
      JSON.stringify({
        v: 1,
        sort: 'name',
        direction: 'asc',
        value: 'model 009000',
        id: fixtureUuid('model-9000'),
      }),
    ).toString('base64url');
    const paths = [
      '/api/v1/catalogue/models',
      '/api/v1/catalogue/models?q=reference-needle-9999',
      '/api/v1/catalogue/models?favorite=true&format=stl&source=upload&printed=true&sort=name&direction=asc',
      `/api/v1/catalogue/models?tagId=${tagId}&collectionId=${collectionId}`,
      '/api/v1/catalogue/models?failed=true&sort=lastPrintedAt&direction=desc',
      `/api/v1/catalogue/models?sort=name&direction=asc&cursor=${deepCursor}`,
    ];
    const measurements: string[] = [];

    for (const path of paths) {
      const startedAt = performance.now();
      const response = await fetch(new URL(path, baseUrl), {
        headers: { 'x-request-id': fixtureUuid(`request-${path}`) },
      });
      const elapsedMs = performance.now() - startedAt;
      expect(response.status, path).toBe(200);
      const body = (await response.json()) as {
        readonly items: readonly {
          readonly thumbnail: { readonly status: string; readonly downloadUrl: string | null };
        }[];
      };
      expect(body.items.length, path).toBeLessThanOrEqual(50);
      expect(
        body.items.every((item) => typeof item.thumbnail.status === 'string'),
        path,
      ).toBe(true);
      expect(elapsedMs, `${path} took ${elapsedMs.toFixed(1)} ms`).toBeLessThan(twoSecondTargetMs);
      measurements.push(`${path}=${elapsedMs.toFixed(1)}ms`);
    }
    console.info(`O04 uncached API measurements: ${measurements.join(', ')}`);
  });

  it('offers indexed plans for catalogue and print-history access paths', async () => {
    const plans = await database.transaction().execute(async (transaction) => {
      await sql`set local enable_seqscan = off`.execute(transaction);
      return Promise.all([
        explain(
          transaction,
          sql`
            select id from catalogue_models
            where owner_id = ${ownerId}
            order by updated_at desc, id asc
            limit 51
          `,
        ),
        explain(
          transaction,
          sql`
            select id from catalogue_models
            where search_document @@ plainto_tsquery('simple', '9999')
          `,
        ),
        explain(
          transaction,
          sql`
            select model_id from catalogue_model_tags
            where tag_id = ${fixtureUuid('tag-20')}
          `,
        ),
        explain(
          transaction,
          sql`
            select id from print_attempts
            where owner_id = ${ownerId}
              and model_id = ${fixtureUuid('model-42')}
            order by coalesce(completed_at, started_at, created_at) desc, id desc
            limit 50
          `,
        ),
        explain(
          transaction,
          sql`
            select 1 from print_attempts
            where owner_id = ${ownerId}
              and model_id = ${fixtureUuid('model-42')}
              and outcome = 'failed'
            limit 1
          `,
        ),
        explain(
          transaction,
          sql`
            select id from catalogue_generated_artifacts
            where owner_id = ${ownerId}
              and source_asset_id = ${fixtureUuid('asset-42-3')}
              and kind = 'thumbnail'
          `,
        ),
      ]);
    });

    const serialized = plans.map((plan) => JSON.stringify(plan));
    expect(serialized[0]).toContain('catalogue_models_owner_updated_idx');
    expect(serialized[1]).toContain('catalogue_models_search_document_idx');
    expect(serialized[2]).toContain('catalogue_model_tags_tag_idx');
    expect(serialized[3]).toContain('print_attempts_owner_model_history_idx');
    expect(serialized[4]).toContain('print_attempts_owner_failed_model_idx');
    expect(serialized[5]).toContain('catalogue_generated_artifacts_owner_asset_idx');
  });
});

async function seedReferenceDataset(database: Database<ApiDatabaseSchema>): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await sql`set constraints all deferred`.execute(transaction);
    await sql`
      insert into identity_users (
        id, username, normalized_username, password_hash, created_at, updated_at
      ) values (
        ${ownerId}, 'Reference Owner', 'reference owner', 'not-used-by-performance-tests',
        timestamptz '2026-01-01', timestamptz '2026-01-01'
      )
    `.execute(transaction);
    await sql`
      insert into stored_objects (
        id, backend, object_key, checksum, byte_size, state, reference_count, created_at, updated_at
      )
      select
        md5('object-' || model || '-' || version)::uuid,
        'local',
        'reference/' || model || '/' || version,
        md5('checksum-' || model || '-' || version)
          || md5('checksum-tail-' || model || '-' || version),
        1024 + model,
        'committed',
        0,
        timestamptz '2026-01-01',
        timestamptz '2026-01-01'
      from generate_series(1, 10000) model
      cross join generate_series(1, 3) version
    `.execute(transaction);
    await sql`
      insert into catalogue_models (
        id, owner_id, name, description, import_source, source_url, creator, license,
        favorite, current_version_id, cover_asset_id, print_count, last_printed_at,
        created_at, updated_at
      )
      select
        md5('model-' || model)::uuid,
        ${ownerId},
        'Model ' || lpad(model::text, 6, '0'),
        case
          when model = 9999 then 'reference-needle-9999'
          else 'Reference printable model with representative metadata'
        end,
        case when model % 2 = 0 then 'upload' else 'yuki_export' end,
        case when model % 5 = 0 then 'https://models.example.test/' || model else null end,
        case when model % 4 = 0 then 'Reference creator ' || model % 20 else null end,
        'reference-license',
        model % 7 = 0,
        md5('version-' || model || '-3')::uuid,
        null,
        model % 8,
        case
          when model % 8 = 0 then null
          else timestamptz '2026-01-01' + (model % 120) * interval '1 hour'
        end,
        timestamptz '2025-01-01' + model * interval '1 minute',
        timestamptz '2026-01-01' + (model % 365) * interval '1 minute'
      from generate_series(1, 10000) model
    `.execute(transaction);
    await sql`
      insert into catalogue_model_versions (
        id, model_id, label, change_note, metadata_schema_version, metadata_snapshot,
        created_at, published_at
      )
      select
        md5('version-' || model || '-' || version)::uuid,
        md5('model-' || model)::uuid,
        'v' || version,
        case when version > 1 then 'Reference revision ' || version else null end,
        1,
        jsonb_build_object('material', case when model % 2 = 0 then 'PLA' else 'PETG' end),
        timestamptz '2025-01-01' + version * interval '1 day',
        null
      from generate_series(1, 10000) model
      cross join generate_series(1, 3) version
    `.execute(transaction);
    await sql`
      insert into catalogue_assets (
        id, model_id, model_version_id, stored_object_id, role, format,
        original_filename, detected_mime_type, byte_size, checksum, imported_at, published_at
      )
      select
        md5('asset-' || model || '-' || version)::uuid,
        md5('model-' || model)::uuid,
        md5('version-' || model || '-' || version)::uuid,
        md5('object-' || model || '-' || version)::uuid,
        'geometry',
        case when model % 3 = 0 then 'obj' else 'stl' end,
        'model-' || model || '-v' || version || case when model % 3 = 0 then '.obj' else '.stl' end,
        case when model % 3 = 0 then 'model/obj' else 'model/stl' end,
        1024 + model,
        md5('checksum-' || model || '-' || version)
          || md5('checksum-tail-' || model || '-' || version),
        timestamptz '2025-01-01' + version * interval '1 day',
        timestamptz '2025-01-01' + version * interval '1 day'
      from generate_series(1, 10000) model
      cross join generate_series(1, 3) version
    `.execute(transaction);
    await sql`
      update catalogue_model_versions
      set published_at = created_at
    `.execute(transaction);
    await sql`
      insert into stored_objects (
        id, backend, object_key, checksum, byte_size, state, reference_count,
        created_at, updated_at
      )
      select
        md5('thumbnail-object-' || model)::uuid,
        'local',
        'reference/thumbnails/' || model || '.svg',
        md5('thumbnail-checksum-' || model) || md5('thumbnail-tail-' || model),
        2048,
        'committed',
        1,
        timestamptz '2026-01-02',
        timestamptz '2026-01-02'
      from generate_series(1, 7000) model
    `.execute(transaction);
    await sql`
      insert into catalogue_generated_artifacts (
        id, owner_id, source_asset_id, kind, status, generator, generator_version,
        stored_object_id, mime_type, byte_size, dimensions, summary, failure_code,
        failure_message, attempt, created_at, updated_at, completed_at
      )
      select
        md5('thumbnail-artifact-' || model)::uuid,
        ${ownerId},
        md5('asset-' || model || '-3')::uuid,
        'thumbnail',
        case
          when model <= 7000 then 'ready'
          when model <= 7500 then 'processing'
          when model <= 7750 then 'failed'
          else 'unsupported'
        end,
        'yuki-preview',
        '1',
        case when model <= 7000 then md5('thumbnail-object-' || model)::uuid else null end,
        case when model <= 7000 then 'image/svg+xml' else null end,
        case when model <= 7000 then 2048 else null end,
        null,
        null,
        case
          when model > 7500 and model <= 7750 then 'conversion_failed'
          when model > 7750 then 'unsupported_geometry'
          else null
        end,
        case
          when model > 7500 and model <= 7750 then 'Thumbnail generation failed.'
          when model > 7750 then 'Thumbnail generation is unsupported.'
          else null
        end,
        case when model <= 7500 then 1 else 0 end,
        timestamptz '2026-01-02',
        timestamptz '2026-01-02',
        case
          when model <= 7000 or model > 7500 then timestamptz '2026-01-02'
          else null
        end
      from generate_series(1, 8000) model
    `.execute(transaction);
    await sql`
      insert into stored_object_references (
        stored_object_id, owner_type, owner_id, created_at
      )
      select
        md5('thumbnail-object-' || model)::uuid,
        'catalogue_generated_artifact',
        md5('thumbnail-artifact-' || model)::uuid,
        timestamptz '2026-01-02'
      from generate_series(1, 7000) model
    `.execute(transaction);
    await sql`
      insert into catalogue_tags (id, owner_id, name, normalized_name, created_at)
      select
        md5('tag-' || tag)::uuid,
        ${ownerId},
        'tag ' || lpad(tag::text, 3, '0'),
        'tag ' || lpad(tag::text, 3, '0'),
        timestamptz '2025-01-01'
      from generate_series(1, 100) tag
    `.execute(transaction);
    await sql`
      insert into catalogue_collections (
        id, owner_id, name, normalized_name, description, created_at, updated_at
      )
      select
        md5('collection-' || collection)::uuid,
        ${ownerId},
        'collection ' || lpad(collection::text, 3, '0'),
        'collection ' || lpad(collection::text, 3, '0'),
        'Reference collection',
        timestamptz '2025-01-01',
        timestamptz '2025-01-01'
      from generate_series(1, 100) collection
    `.execute(transaction);
    await sql`
      insert into catalogue_model_tags (model_id, tag_id, owner_id, created_at)
      select
        md5('model-' || model)::uuid,
        md5('tag-' || (((model + slot - 2) % 100) + 1))::uuid,
        ${ownerId},
        timestamptz '2025-01-01'
      from generate_series(1, 10000) model
      cross join generate_series(1, 5) slot
    `.execute(transaction);
    await sql`
      insert into catalogue_model_collections (
        model_id, collection_id, owner_id, created_at
      )
      select
        md5('model-' || model)::uuid,
        md5('collection-' || (((model + slot - 2) % 100) + 1))::uuid,
        ${ownerId},
        timestamptz '2025-01-01'
      from generate_series(1, 10000) model
      cross join generate_series(1, 5) slot
    `.execute(transaction);
    await sql`
      insert into printers (
        id, owner_id, display_name, octoprint_url, encrypted_api_key, enabled,
        connection_status, operational_state, profile_schema_version, profile,
        created_at, updated_at, verified_at
      ) values (
        ${printerId}, ${ownerId}, 'Reference printer', 'http://printer.local/', 'encrypted',
        true, 'online', 'operational', 1, '{}'::jsonb,
        timestamptz '2025-01-01', timestamptz '2025-01-01', timestamptz '2025-01-01'
      )
    `.execute(transaction);
    await sql`
      insert into print_attempts (
        id, owner_id, queue_entry_id, printer_id, model_id, model_version_id, asset_id,
        state, outcome, printer_snapshot, model_snapshot, asset_snapshot,
        compatibility_snapshot, override_justification, started_at, completed_at,
        created_at, updated_at, source, notes, statistics
      )
      select
        md5('attempt-' || attempt)::uuid,
        ${ownerId},
        null,
        ${printerId},
        md5('model-' || (((attempt - 1) % 10000) + 1))::uuid,
        md5('version-' || (((attempt - 1) % 10000) + 1) || '-3')::uuid,
        md5('asset-' || (((attempt - 1) % 10000) + 1) || '-3')::uuid,
        case when attempt % 7 = 0 then 'failed' else 'completed' end,
        case when attempt % 7 = 0 then 'failed' else 'successful' end,
        jsonb_build_object('id', ${printerId}::text, 'name', 'Reference printer'),
        jsonb_build_object('id', md5('model-' || (((attempt - 1) % 10000) + 1))),
        jsonb_build_object('id', md5('asset-' || (((attempt - 1) % 10000) + 1) || '-3')),
        '{}'::jsonb,
        null,
        timestamptz '2026-01-01' + attempt * interval '1 minute',
        timestamptz '2026-01-01' + attempt * interval '1 minute' + interval '30 minutes',
        timestamptz '2026-01-01' + attempt * interval '1 minute',
        timestamptz '2026-01-01' + attempt * interval '1 minute' + interval '30 minutes',
        'manual',
        case when attempt % 10 = 0 then 'Representative print note' else '' end,
        jsonb_build_object('durationSeconds', 1800)
      from generate_series(1, 5000) attempt
    `.execute(transaction);
  });

  for (const table of [
    'catalogue_models',
    'catalogue_model_versions',
    'catalogue_assets',
    'catalogue_model_tags',
    'catalogue_model_collections',
    'catalogue_generated_artifacts',
    'print_attempts',
  ])
    await sql.raw(`analyze ${table}`).execute(database);
}

async function explain(
  database: Pick<Database<ApiDatabaseSchema>, 'executeQuery' | 'getExecutor'>,
  query: ReturnType<typeof sql>,
) {
  return sql`explain (format json, costs true) ${query}`.execute(database);
}

function fixtureUuid(value: string): string {
  const hex = createHash('md5').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

function configuration(connectionString: string, applicationName: string) {
  return {
    connectionString,
    maximumPoolSize: 2,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 5_000,
    statementTimeoutMs: 120_000,
    applicationName,
  };
}
