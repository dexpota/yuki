import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  closeDatabase,
  createDatabase,
  type Database,
  type DatabaseSchema,
  readDatabaseConfiguration,
} from '../database/index.js';
import {
  createBlobStore,
  readStorageConfiguration,
  type StorageConfiguration,
  type StorageSchema,
} from '../storage/index.js';
import {
  createBackup,
  extractDatabaseDump,
  restoreStorage,
  verifyBackup,
  verifyLiveObjects,
} from './backup.js';

type MaintenanceDatabaseSchema = DatabaseSchema & StorageSchema;

try {
  const command = process.argv[2];
  if (!command)
    throw new Error(
      'Usage: maintenance <create|verify|extract-database|restore-storage|integrity>',
    );

  const storage = readStorageConfiguration(process.env);
  const blobs = await createBlobStore(storage);
  if (command === 'create') {
    const dumpPath = process.argv[3];
    if (!dumpPath) throw new Error('Usage: maintenance create <database-dump>');
    await withDatabase(async (database) => {
      const archive = await createBackup(database, blobs, storage, dumpPath);
      await pipeline(Readable.from(archive), process.stdout);
    });
  } else if (command === 'verify') {
    const manifest = await verifyBackup(process.stdin, blobs, storage);
    status('backup_verified', manifest.objects.length, storage);
  } else if (command === 'extract-database') {
    await extractDatabaseDump(process.stdin, process.stdout);
  } else if (command === 'restore-storage') {
    const manifest = await restoreStorage(process.stdin, blobs, storage);
    status('backup_storage_restored', manifest.objects.length, storage);
  } else if (command === 'integrity') {
    await withDatabase(async (database) => {
      const result = await verifyLiveObjects(database, blobs, storage);
      status('restored_installation_verified', result.verified, storage);
    });
  } else {
    throw new Error(`Unknown maintenance command: ${command}`);
  }
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : 'Maintenance command failed');
}

async function withDatabase(
  operation: (database: Database<MaintenanceDatabaseSchema>) => Promise<void>,
): Promise<void> {
  const database = createDatabase<MaintenanceDatabaseSchema>(
    readDatabaseConfiguration({
      ...process.env,
      YUKI_DATABASE_APPLICATION_NAME: 'yuki-maintenance',
    }),
  );
  try {
    await operation(database);
  } finally {
    await closeDatabase(database);
  }
}

function status(event: string, objects: number, storage: StorageConfiguration): void {
  console.error(JSON.stringify({ event, storageBackend: storage.backend, objects }));
}
