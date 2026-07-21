import { resolve } from 'node:path';

import {
  closeDatabase,
  createDatabase,
  loadMigrations,
  migrateDown,
  migrateUp,
  readDatabaseConfiguration,
} from './index.js';

const database = createDatabase(readDatabaseConfiguration(process.env));

try {
  const directory = resolve(process.env.YUKI_MIGRATIONS_DIRECTORY ?? 'migrations');
  const migrations = await loadMigrations(directory);
  const command = process.argv[2] ?? 'up';

  if (command === 'up') {
    const result = await migrateUp(database, migrations);
    console.info(JSON.stringify({ event: 'database_migrations_applied', ...result }));
  } else if (command === 'down') {
    const steps = readRollbackSteps(process.argv[3]);
    const result = await migrateDown(database, migrations, steps);
    console.info(JSON.stringify({ event: 'database_migrations_reverted', ...result }));
  } else {
    throw new Error(`Unknown migration command: ${command}`);
  }
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : 'Database migration failed');
} finally {
  await closeDatabase(database);
}

function readRollbackSteps(value: string | undefined): number {
  if (value === undefined) return 1;
  if (!/^\d+$/.test(value)) throw new Error('Rollback steps must be a positive integer');
  const steps = Number(value);
  if (!Number.isSafeInteger(steps) || steps < 1) {
    throw new Error('Rollback steps must be a positive integer');
  }
  return steps;
}
