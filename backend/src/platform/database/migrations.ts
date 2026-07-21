import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { type Kysely, sql } from 'kysely';

import { withTransaction } from './transaction.js';

const migrationFilePattern = /^(\d{4,})_([a-z0-9]+(?:_[a-z0-9]+)*)\.(up|down)\.sql$/;
const migrationLockKey = 'yuki:database-migrations';

export interface MigrationDefinition {
  readonly id: string;
  readonly upSql: string;
  readonly downSql: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly reverted: readonly string[];
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

export async function loadMigrations(directory: string): Promise<readonly MigrationDefinition[]> {
  const fileNames = await readdir(directory);
  const parts = new Map<string, { ordinal: string; upSql?: string; downSql?: string }>();
  const ordinals = new Map<string, string>();

  for (const fileName of fileNames.sort()) {
    const match = migrationFilePattern.exec(fileName);
    if (!match) continue;

    const [, ordinal, name, direction] = match;
    if (!ordinal || !name || !direction) continue;
    const id = `${ordinal}_${name}`;
    const otherId = ordinals.get(ordinal);
    if (otherId && otherId !== id) {
      throw new MigrationError(`Migration order ${ordinal} is used by both ${otherId} and ${id}`);
    }
    ordinals.set(ordinal, id);

    const migration = parts.get(id) ?? { ordinal };
    const source = await readFile(resolve(directory, fileName), 'utf8');
    if (direction === 'up') migration.upSql = source;
    else migration.downSql = source;
    parts.set(id, migration);
  }

  return [...parts.entries()]
    .sort(([, left], [, right]) => left.ordinal.localeCompare(right.ordinal))
    .map(([id, migration]) => {
      if (migration.upSql === undefined || migration.downSql === undefined) {
        throw new MigrationError(`Migration ${id} must have matching .up.sql and .down.sql files`);
      }
      return {
        id,
        upSql: migration.upSql,
        downSql: migration.downSql,
        checksum: checksum(migration.upSql, migration.downSql),
      };
    });
}

interface AppliedMigrationRow {
  readonly id: string;
  readonly checksum: string;
}

export async function migrateUp<Schema>(
  database: Kysely<Schema>,
  migrations: readonly MigrationDefinition[],
): Promise<MigrationResult> {
  validateMigrationOrder(migrations);

  return withTransaction(database, async (transaction) => {
    await lockAndPrepare(transaction);
    const appliedRows = await sql<AppliedMigrationRow>`
      select id, checksum from yuki_migrations order by id asc
    `.execute(transaction);
    const available = new Map(migrations.map((migration) => [migration.id, migration]));

    for (const applied of appliedRows.rows) {
      const migration = available.get(applied.id);
      if (!migration) {
        throw new MigrationError(`Applied migration ${applied.id} is missing from the artifact`);
      }
      if (migration.checksum !== applied.checksum) {
        throw new MigrationError(`Applied migration ${applied.id} has been modified`);
      }
    }

    const appliedIds = new Set(appliedRows.rows.map(({ id }) => id));
    for (const [index, applied] of appliedRows.rows.entries()) {
      if (migrations[index]?.id !== applied.id) {
        throw new MigrationError('Applied migrations are not a prefix of the ordered artifact');
      }
    }
    const pending = migrations.filter(({ id }) => !appliedIds.has(id));
    for (const migration of pending) {
      await sql.raw(migration.upSql).execute(transaction);
      await sql`
        insert into yuki_migrations (id, checksum, applied_at)
        values (${migration.id}, ${migration.checksum}, ${new Date()})
      `.execute(transaction);
    }

    return { applied: pending.map(({ id }) => id), reverted: [] };
  });
}

export async function migrateDown<Schema>(
  database: Kysely<Schema>,
  migrations: readonly MigrationDefinition[],
  steps = 1,
): Promise<MigrationResult> {
  if (!Number.isSafeInteger(steps) || steps < 1) {
    throw new MigrationError('Migration rollback steps must be a positive integer');
  }
  validateMigrationOrder(migrations);

  return withTransaction(database, async (transaction) => {
    await lockAndPrepare(transaction);
    const appliedRows = await sql<AppliedMigrationRow>`
      select id, checksum from yuki_migrations order by id desc limit ${steps}
    `.execute(transaction);
    const available = new Map(migrations.map((migration) => [migration.id, migration]));
    const reverted: string[] = [];

    for (const applied of appliedRows.rows) {
      const migration = available.get(applied.id);
      if (!migration) {
        throw new MigrationError(`Applied migration ${applied.id} is missing from the artifact`);
      }
      if (migration.checksum !== applied.checksum) {
        throw new MigrationError(`Applied migration ${applied.id} has been modified`);
      }
      await sql.raw(migration.downSql).execute(transaction);
      await sql`delete from yuki_migrations where id = ${migration.id}`.execute(transaction);
      reverted.push(migration.id);
    }

    return { applied: [], reverted };
  });
}

async function lockAndPrepare<Schema>(database: Kysely<Schema>): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${migrationLockKey}))`.execute(database);
  await sql`
    create table if not exists yuki_migrations (
      id text primary key,
      checksum text not null,
      applied_at timestamptz not null
    )
  `.execute(database);
}

function validateMigrationOrder(migrations: readonly MigrationDefinition[]): void {
  let previous: string | undefined;
  const ids = new Set<string>();
  for (const migration of migrations) {
    if (ids.has(migration.id)) throw new MigrationError(`Duplicate migration ${migration.id}`);
    if (previous !== undefined && migration.id <= previous) {
      throw new MigrationError('Migrations must be supplied in ascending global order');
    }
    ids.add(migration.id);
    previous = migration.id;
  }
}

function checksum(upSql: string, downSql: string): string {
  return createHash('sha256').update(upSql).update('\0').update(downSql).digest('hex');
}
