import { readFile } from 'node:fs/promises';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type CatalogueDatabaseSchema, CatalogueService } from '../../../src/catalogue/index.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../../src/platform/database/index.js';
import {
  type CompatibilityDatabaseSchema,
  CompatibilityService,
} from '../../../src/printing/compatibility/index.js';
import { normalizePrinterProfile } from '../../../src/printing/printers/public.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('persisted compatibility evaluations', () => {
  let database: Database<CompatibilityDatabaseSchema>;
  const schemaName = `p04_${process.pid}_${Date.now()}`;
  const ownerId = '10000000-0000-4000-8000-000000000001';
  const modelId = '20000000-0000-4000-8000-000000000001';
  const versionId = '30000000-0000-4000-8000-000000000001';
  const objectId = '40000000-0000-4000-8000-000000000001';
  const assetId = '50000000-0000-4000-8000-000000000001';
  const printerId = '60000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    const setup = createDatabase<CompatibilityDatabaseSchema>(
      configuration(databaseUrl as string, 'p04-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<CompatibilityDatabaseSchema>(
      configuration(url.toString(), 'p04-test'),
    );
    await migrate(database, '0002_storage_objects.up.sql');
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerId})`.execute(database);
    await migrate(database, '0004_catalogue.up.sql');
    await migrate(database, '0008_printers.up.sql');
    await migrate(database, '0013_printing_compatibility.up.sql');
    await database
      .insertInto('stored_objects')
      .values({
        id: objectId,
        backend: 'local',
        object_key: 'gcode/test.gcode',
        checksum: 'ab'.repeat(32),
        byte_size: 100,
        state: 'committed',
        reference_count: 1,
        delete_after: null,
        deletion_error: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .executeTakeFirstOrThrow();
    await new CatalogueService(
      database as unknown as Database<CatalogueDatabaseSchema>,
    ).createModel(ownerId, {
      id: modelId,
      name: 'Compatibility cube',
      importSource: 'upload',
      initialVersion: {
        id: versionId,
        label: 'v1',
        metadataSnapshot: {},
        assets: [
          {
            id: assetId,
            storedObjectId: objectId,
            role: 'gcode',
            format: 'gcode',
            originalFilename: 'cube.gcode',
            detectedMimeType: 'text/x.gcode',
            byteSize: 100,
            checksum: 'ab'.repeat(32),
          },
        ],
      },
    });
    const profile = normalizePrinterProfile({
      buildVolume: {
        shape: 'rectangular',
        widthMm: 220,
        depthMm: 220,
        heightMm: 250,
        origin: 'lowerleft',
      },
      compatibility: {
        gcodeFlavors: ['marlin'],
        nozzleDiameterMm: 0.4,
        extruderCount: 1,
      },
    });
    await database
      .insertInto('printers')
      .values({
        id: printerId,
        owner_id: ownerId,
        display_name: 'Workshop printer',
        octoprint_url: 'http://printer.local',
        encrypted_api_key: 'encrypted',
        enabled: true,
        connection_status: 'online',
        operational_state: 'operational',
        profile_schema_version: 1,
        profile,
        created_at: new Date(),
        updated_at: new Date(),
        verified_at: new Date(),
        version: 1,
      })
      .executeTakeFirstOrThrow();
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<CompatibilityDatabaseSchema>(
      configuration(databaseUrl as string, 'p04-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('persists owner-scoped immutable input and result snapshots', async () => {
    const result = await new CompatibilityService(database).evaluate({
      ownerId,
      assetId,
      printerId,
      processorFacts: facts(),
      evaluatedAt: new Date('2026-07-23T12:00:00.000Z'),
    });
    expect(result.snapshot).toMatchObject({
      ruleSetVersion: '1.0.0',
      result: { status: 'compatible' },
      gcode: { assetId, assetSha256: 'ab'.repeat(32) },
      printer: { printerId, displayName: 'Workshop printer' },
    });
    const row = await database
      .selectFrom('printing_compatibility_evaluations')
      .selectAll()
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      owner_id: ownerId,
      asset_id: assetId,
      printer_id: printerId,
      rule_set_version: '1.0.0',
      status: 'compatible',
    });
    await expect(
      database
        .updateTable('printing_compatibility_evaluations')
        .set({ status: 'warning' })
        .where('id', '=', result.id)
        .execute(),
    ).rejects.toThrow('compatibility evaluations are immutable');
  });
});

function facts() {
  const evidence = [{ source: 'comment', line: 1, key: 'test' }];
  const known = <T>(value: T) => ({ status: 'known', value, evidence });
  return {
    schemaVersion: 1,
    parser: { name: 'yuki-gcode', version: '1.0.0' },
    buildBounds: known({
      minimum: { x: 0, y: 0, z: 0.2 },
      maximum: { x: 100, y: 100, z: 10.2 },
      size: { width: 100, depth: 100, height: 10 },
      unit: 'mm',
    }),
    targetPrinter: known('Workshop printer'),
    flavor: known('marlin'),
    nozzleDiametersMm: known([0.4]),
    extruderCount: known(1),
    slicer: { status: 'unknown', reason: 'not-found' },
    statistics: { linesRead: 20, movementSegments: 10 },
  };
}

async function migrate(database: Database<CompatibilityDatabaseSchema>, filename: string) {
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
