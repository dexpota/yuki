import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DatabaseConfiguration } from './configuration.js';
import type { DatabaseSchema } from './schema.js';

export type Database<Schema = DatabaseSchema> = Kysely<Schema>;

export function createDatabase<Schema = DatabaseSchema>(
  configuration: DatabaseConfiguration,
): Database<Schema> {
  const pool = new Pool({
    connectionString: configuration.connectionString,
    max: configuration.maximumPoolSize,
    connectionTimeoutMillis: configuration.connectionTimeoutMs,
    idleTimeoutMillis: configuration.idleTimeoutMs,
    statement_timeout: configuration.statementTimeoutMs,
    application_name: configuration.applicationName,
  });

  return new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });
}

export async function closeDatabase<Schema>(database: Database<Schema>): Promise<void> {
  await database.destroy();
}
