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
  PrintPlanConflictError,
  type PrintPlanningDatabaseSchema,
  PrintPlanningService,
} from '../../../src/printing/planning/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
type TestSchema = PrintPlanningDatabaseSchema & CatalogueDatabaseSchema;

integration('persistent printer independent print plan', () => {
  let database: Database<TestSchema>;
  let catalogue: CatalogueService;
  let plan: PrintPlanningService;
  const schemaName = `print_plan_${process.pid}_${Date.now()}`;
  const ownerId = uuid(1);
  const otherOwnerId = uuid(2);
  const modelId = uuid(3);
  const versionId = uuid(4);
  const secondVersionId = uuid(8);
  const assetId = uuid(5);

  beforeAll(async () => {
    const setup = createDatabase<TestSchema>(configuration(databaseUrl as string, 'plan-setup'));
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<TestSchema>(configuration(url.toString(), 'plan-test'));
    await migrate('0002_storage_objects.up.sql');
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerId}), (${otherOwnerId})`.execute(
      database,
    );
    await migrate('0004_catalogue.up.sql');
    await migrate('0022_print_planning_queue.up.sql');
    await database
      .insertInto('stored_objects')
      .values({
        id: uuid(6),
        backend: 'local',
        object_key: 'plan.gcode',
        checksum: 'ab'.repeat(32),
        byte_size: 5,
        state: 'committed',
        reference_count: 1,
        delete_after: null,
        deletion_error: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    catalogue = new CatalogueService(database as unknown as Database<CatalogueDatabaseSchema>);
    await catalogue.createModel(ownerId, {
      id: modelId,
      name: 'Plan model',
      importSource: 'upload',
      initialVersion: {
        id: versionId,
        label: 'v1',
        metadataSnapshot: {},
        assets: [
          {
            id: assetId,
            storedObjectId: uuid(6),
            role: 'gcode',
            format: 'gcode',
            originalFilename: 'plan.gcode',
            detectedMimeType: 'text/x.gcode',
            byteSize: 5,
            checksum: 'ab'.repeat(32),
          },
        ],
      },
    });
    plan = new PrintPlanningService(database);
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<TestSchema>(
      configuration(databaseUrl as string, 'plan-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('keeps exact version references, owner isolation, reorder, and unavailable snapshots', async () => {
    const entry = await plan.create(ownerId, modelId, versionId);
    expect(entry).toMatchObject({
      modelId,
      versionId,
      modelName: 'Plan model',
      versionLabel: 'v1',
      unavailable: false,
      assets: [{ id: assetId, filename: 'plan.gcode' }],
      position: 0,
    });
    await catalogue.addVersion(ownerId, modelId, {
      id: secondVersionId,
      label: 'v2',
      metadataSnapshot: {},
      assets: [
        {
          id: uuid(10),
          storedObjectId: uuid(6),
          role: 'geometry',
          format: 'stl',
          originalFilename: 'plan-v2.stl',
          detectedMimeType: 'model/stl',
          byteSize: 5,
          checksum: 'ab'.repeat(32),
        },
      ],
    });
    const secondEntry = await plan.create(ownerId, modelId, secondVersionId);
    const ordered = await plan.reorder(ownerId, [secondEntry.id, entry.id]);
    expect(ordered.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: secondEntry.id, position: 0 },
      { id: entry.id, position: 1 },
    ]);
    const afterRestart = new PrintPlanningService(database);
    expect(await afterRestart.list(ownerId)).toMatchObject([
      { id: secondEntry.id, versionId: secondVersionId, position: 0 },
      { id: entry.id, versionId, position: 1 },
    ]);
    await expect(plan.create(ownerId, modelId, versionId)).rejects.toBeInstanceOf(
      PrintPlanConflictError,
    );
    await expect(plan.reorder(otherOwnerId, [entry.id, secondEntry.id])).rejects.toBeInstanceOf(
      PrintPlanConflictError,
    );
    await expect(plan.remove(otherOwnerId, entry.id)).rejects.toThrow();
    await catalogue.deleteModel(ownerId, modelId);
    expect(await plan.list(ownerId)).toEqual([
      expect.objectContaining({
        id: secondEntry.id,
        modelId,
        versionId: secondVersionId,
        modelName: 'Plan model',
        versionLabel: 'v2',
        unavailable: true,
        assets: [],
        position: 0,
      }),
      expect.objectContaining({
        id: entry.id,
        modelId,
        versionId,
        modelName: 'Plan model',
        versionLabel: 'v1',
        unavailable: true,
        assets: [],
        position: 1,
      }),
    ]);
    await plan.remove(ownerId, secondEntry.id);
    await plan.remove(ownerId, entry.id);
    expect(await plan.list(ownerId)).toEqual([]);
  });

  async function migrate(filename: string) {
    await sql
      .raw(await readFile(new URL(`../../../migrations/${filename}`, import.meta.url), 'utf8'))
      .execute(database);
  }
});

function configuration(connectionString: string, applicationName: string) {
  return {
    connectionString,
    maximumPoolSize: 4,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: 10_000,
    applicationName,
  };
}
function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
