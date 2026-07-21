import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createDatabase,
  loadMigrations,
  migrateDown,
  migrateUp,
  withTransaction,
  type Database,
  type DatabaseSchema,
} from '../../src/platform/database/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('PostgreSQL database foundation', () => {
  let database: Database<TestSchema>;
  let migrationDirectory: string;
  const schemaName = `f05_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    migrationDirectory = await mkdtemp(join(tmpdir(), 'yuki-f05-'));
    await writeMigration(
      migrationDirectory,
      '0001_counter',
      'create table counter (value integer not null); insert into counter values (1)',
      'drop table counter',
    );
    await writeMigration(
      migrationDirectory,
      '0002_increment',
      'update counter set value = value + 1',
      'update counter set value = value - 1',
    );

    const setup = createDatabase<TestSchema>(configuration(databaseUrl as string, 'f05-setup'));
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);

    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<TestSchema>(configuration(url.toString(), 'f05-test'));
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<TestSchema>(configuration(databaseUrl as string, 'f05-cleanup'));
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
    if (migrationDirectory) await rm(migrationDirectory, { recursive: true });
  });

  it('applies paired migrations in global order and is idempotent', async () => {
    const migrations = await loadMigrations(migrationDirectory);

    await expect(migrateUp(database, migrations)).resolves.toEqual({
      applied: ['0001_counter', '0002_increment'],
      reverted: [],
    });
    await expect(migrateUp(database, migrations)).resolves.toEqual({ applied: [], reverted: [] });
    await expect(
      sql<{ value: number }>`select value from counter`.execute(database),
    ).resolves.toMatchObject({ rows: [{ value: 2 }] });
  });

  it('rolls migrations back from newest to oldest', async () => {
    const migrations = await loadMigrations(migrationDirectory);

    await expect(migrateDown(database, migrations)).resolves.toEqual({
      applied: [],
      reverted: ['0002_increment'],
    });
    await expect(
      sql<{ value: number }>`select value from counter`.execute(database),
    ).resolves.toMatchObject({ rows: [{ value: 1 }] });
    await migrateDown(database, migrations);
    await expect(sql`select value from counter`.execute(database)).rejects.toThrow();
  });

  it('rolls a failed unit of work back atomically', async () => {
    await sql`create table transaction_probe (value integer not null)`.execute(database);

    await expect(
      withTransaction(database, async (transaction) => {
        await sql`insert into transaction_probe values (1)`.execute(transaction);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    const result = await sql<{
      count: string;
    }>`select count(*) as count from transaction_probe`.execute(database);
    expect(result.rows[0]?.count).toBe('0');
  });
});

interface TestSchema extends DatabaseSchema {
  readonly counter: { readonly value: number };
  readonly transaction_probe: { readonly value: number };
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

async function writeMigration(
  directory: string,
  id: string,
  upSql: string,
  downSql: string,
): Promise<void> {
  await writeFile(join(directory, `${id}.up.sql`), upSql);
  await writeFile(join(directory, `${id}.down.sql`), downSql);
}
