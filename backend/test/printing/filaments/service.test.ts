import { readFile } from 'node:fs/promises';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../../src/platform/database/index.js';
import {
  FilamentPresetConflictError,
  type FilamentPresetDatabaseSchema,
  FilamentPresetNotFoundError,
  FilamentPresetService,
} from '../../../src/printing/filaments/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('owner-scoped filament presets', () => {
  let database: Database<FilamentPresetDatabaseSchema>;
  const schemaName = `filament_${process.pid}_${Date.now()}`;
  const ownerOne = '10000000-0000-4000-8000-000000000001';
  const ownerTwo = '10000000-0000-4000-8000-000000000002';
  const presetOne = '22000000-0000-4000-8000-000000000001';
  const presetTwo = '22000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    const setup = createDatabase<FilamentPresetDatabaseSchema>(
      configuration(databaseUrl as string, 'filament-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<FilamentPresetDatabaseSchema>(
      configuration(url.toString(), 'filament-test'),
    );
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerOne}), (${ownerTwo})`.execute(
      database,
    );
    await applyMigration(database, '0022_filament_presets.up.sql');
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<FilamentPresetDatabaseSchema>(
      configuration(databaseUrl as string, 'filament-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('creates, updates, archives, restores, and isolates presets by owner', async () => {
    let nextId = presetOne;
    const service = new FilamentPresetService(database, {
      newId: () => nextId,
      now: () => new Date('2026-09-30T10:00:00.000Z'),
    });
    const created = await service.create(ownerOne, {
      displayName: 'Galaxy Black',
      material: 'PLA',
      colorHex: '#1F2020',
      diameterMm: 1.75,
    });
    expect(created).toMatchObject({ colorHex: '1f2020', diameterMm: 1.75, version: 1 });
    await expect(service.get(ownerTwo, presetOne)).rejects.toBeInstanceOf(
      FilamentPresetNotFoundError,
    );

    const updated = await service.update(ownerOne, presetOne, {
      displayName: 'Prusament PLA — Galaxy Black',
      manufacturer: 'Prusa Polymers',
      expectedVersion: 1,
    });
    expect(updated).toMatchObject({ manufacturer: 'Prusa Polymers', version: 2 });
    await expect(
      service.update(ownerOne, presetOne, { notes: 'stale', expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(FilamentPresetConflictError);
    await expect(
      service.update(ownerOne, presetOne, { notes: 'invalid version', expectedVersion: 0 }),
    ).rejects.toThrow('expectedVersion');

    const archived = await service.archive(ownerOne, presetOne, 2);
    expect(archived).toMatchObject({ version: 3 });
    expect(archived.archivedAt).not.toBeNull();
    await expect(service.list(ownerOne)).resolves.toEqual([]);
    await expect(service.list(ownerOne, { includeArchived: true })).resolves.toHaveLength(1);
    await expect(service.restore(ownerOne, presetOne, 3)).resolves.toMatchObject({
      archivedAt: null,
      version: 4,
    });

    nextId = presetTwo;
    await service.create(ownerTwo, { displayName: 'Galaxy Black', material: 'PLA' });
    await expect(service.list(ownerOne)).resolves.toHaveLength(1);
    await expect(service.list(ownerTwo)).resolves.toHaveLength(1);
  });
});

async function applyMigration(database: Database<FilamentPresetDatabaseSchema>, filename: string) {
  const migration = await readFile(
    new URL(`../../../migrations/${filename}`, import.meta.url),
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
