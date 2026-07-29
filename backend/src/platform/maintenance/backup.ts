import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Kysely } from 'kysely';

import type { DatabaseSchema } from '../database/index.js';
import type {
  BlobStore,
  LocalStorageConfiguration,
  StorageConfiguration,
  StorageSchema,
} from '../storage/index.js';
import { LocalBlobStore } from '../storage/index.js';
import { MaintenanceArchiveError, readTar, type TarEntry, writeTar } from './tar.js';

export const backupFormat = 'yuki-full-backup' as const;
export const backupVersion = 1 as const;
const databasePath = 'database.dump';
const manifestPath = 'manifest.json';
const objectKeyPattern = /^objects\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{64})-([a-f0-9-]{36})$/;
const checksumPattern = /^[a-f0-9]{64}$/;
const maximumArchiveBytes = 8 * 1024 * 1024 * 1024 * 1024;

type MaintenanceDatabaseSchema = DatabaseSchema & StorageSchema;

export interface BackupObjectV1 {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
}

export interface BackupManifestV1 {
  readonly format: typeof backupFormat;
  readonly version: typeof backupVersion;
  readonly createdAt: string;
  readonly database: {
    readonly path: typeof databasePath;
    readonly format: 'postgresql-custom';
    readonly size: number;
    readonly sha256: string;
    readonly migrations: readonly string[];
  };
  readonly storage: {
    readonly backend: 'local' | 's3';
    readonly mode: 'bundled' | 'referenced';
  };
  readonly objects: readonly BackupObjectV1[];
}

export class MaintenanceBackupError extends Error {
  override readonly name = 'MaintenanceBackupError';
}

export async function createBackup(
  database: Kysely<MaintenanceDatabaseSchema>,
  blobs: BlobStore,
  storage: StorageConfiguration,
  dumpPath: string,
  now = new Date(),
): Promise<AsyncIterable<Uint8Array>> {
  const databaseFile = await inspectFile(dumpPath);
  const [rows, migrations] = await Promise.all([
    database
      .selectFrom('stored_objects')
      .select(['backend', 'object_key', 'checksum', 'byte_size'])
      .where('state', '=', 'committed')
      .where('reference_count', '>', 0)
      .orderBy('object_key', 'asc')
      .execute(),
    database.selectFrom('yuki_migrations').select('id').orderBy('id', 'asc').execute(),
  ]);
  const objects = rows.map((row) => ({
    key: row.object_key,
    size: safeSize(row.byte_size),
    sha256: row.checksum,
  }));
  for (const [index, object] of objects.entries()) {
    validateObject(object);
    if (rows[index]?.backend !== storage.backend) {
      throw new MaintenanceBackupError(
        `Stored object ${object.key} belongs to ${rows[index]?.backend}, not ${storage.backend}`,
      );
    }
    await assertObject(blobs, object);
  }

  const manifest: BackupManifestV1 = {
    format: backupFormat,
    version: backupVersion,
    createdAt: now.toISOString(),
    database: {
      path: databasePath,
      format: 'postgresql-custom',
      size: databaseFile.size,
      sha256: databaseFile.sha256,
      migrations: migrations.map(({ id }) => id),
    },
    storage: {
      backend: storage.backend,
      mode: storage.backend === 'local' ? 'bundled' : 'referenced',
    },
    objects,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return writeTar(backupEntries(manifest, manifestBytes, dumpPath, blobs));
}

export async function verifyBackup(
  archive: AsyncIterable<Uint8Array>,
  blobs: BlobStore,
  storage: StorageConfiguration,
): Promise<BackupManifestV1> {
  const manifest = await consumeBackup(archive, { mode: 'verify' });
  assertBackend(manifest, storage);
  if (manifest.storage.backend === 's3') {
    for (const object of manifest.objects) await assertObject(blobs, object);
  }
  return manifest;
}

export async function extractDatabaseDump(
  archive: AsyncIterable<Uint8Array>,
  destination: NodeJS.WritableStream,
): Promise<BackupManifestV1> {
  return consumeBackup(archive, { mode: 'extract-database', destination });
}

export async function restoreStorage(
  archive: AsyncIterable<Uint8Array>,
  blobs: BlobStore,
  storage: StorageConfiguration,
): Promise<BackupManifestV1> {
  if (storage.backend === 's3') {
    const manifest = await consumeBackup(archive, { mode: 'verify' });
    assertBackend(manifest, storage);
    for (const object of manifest.objects) await assertObject(blobs, object);
    return manifest;
  }
  await assertCleanLocalStorage(storage);
  const written: string[] = [];
  try {
    const manifest = await consumeBackup(archive, {
      mode: 'restore-local',
      configuration: storage,
      written,
    });
    assertBackend(manifest, storage);
    return manifest;
  } catch (error) {
    await Promise.allSettled(
      written.map((key) => rm(localObjectPath(storage, key), { force: true })),
    );
    await rm(resolve(storage.root, 'objects'), { recursive: true, force: true });
    await mkdir(resolve(storage.root, 'objects'), { mode: 0o700 });
    throw error;
  }
}

export async function verifyLiveObjects(
  database: Kysely<MaintenanceDatabaseSchema>,
  blobs: BlobStore,
  storage: StorageConfiguration,
): Promise<{ readonly verified: number }> {
  const rows = await database
    .selectFrom('stored_objects')
    .select(['backend', 'object_key', 'checksum', 'byte_size'])
    .where('state', '=', 'committed')
    .where('reference_count', '>', 0)
    .orderBy('object_key', 'asc')
    .execute();
  for (const row of rows) {
    if (row.backend !== storage.backend) {
      throw new MaintenanceBackupError(
        `Stored object ${row.object_key} belongs to ${row.backend}, not ${storage.backend}`,
      );
    }
    await assertObject(blobs, {
      key: row.object_key,
      size: safeSize(row.byte_size),
      sha256: row.checksum,
    });
  }
  return { verified: rows.length };
}

async function* backupEntries(
  manifest: BackupManifestV1,
  manifestBytes: Buffer,
  dumpPath: string,
  blobs: BlobStore,
): AsyncGenerator<TarEntry> {
  yield { path: manifestPath, size: manifestBytes.length, source: single(manifestBytes) };
  yield {
    path: databasePath,
    size: manifest.database.size,
    source: checkedSource(
      createReadStream(dumpPath),
      manifest.database.size,
      manifest.database.sha256,
      databasePath,
    ),
  };
  if (manifest.storage.backend === 'local') {
    for (const object of manifest.objects) {
      yield {
        path: archiveObjectPath(object.key),
        size: object.size,
        source: checkedSource(await blobs.read(object.key), object.size, object.sha256, object.key),
      };
    }
  }
}

type ConsumeMode =
  | { readonly mode: 'verify' }
  | { readonly mode: 'extract-database'; readonly destination: NodeJS.WritableStream }
  | {
      readonly mode: 'restore-local';
      readonly configuration: LocalStorageConfiguration;
      readonly written: string[];
    };

async function consumeBackup(
  archive: AsyncIterable<Uint8Array>,
  mode: ConsumeMode,
): Promise<BackupManifestV1> {
  let manifest: BackupManifestV1 | undefined;
  let entryIndex = 0;
  const seen = new Set<string>();

  try {
    await readTar(
      archive,
      async (entry) => {
        if (entryIndex === 0) {
          if (entry.path !== manifestPath) fail('Backup manifest must be the first archive entry');
          const bytes = await collect(entry.bytes, 4 * 1024 * 1024);
          manifest = parseManifest(bytes);
          seen.add(entry.path);
          entryIndex += 1;
          return;
        }
        if (!manifest) fail('Backup manifest is missing');
        const expectedPath =
          entryIndex === 1
            ? databasePath
            : manifest.storage.backend === 'local'
              ? archiveObjectPath(manifest.objects[entryIndex - 2]?.key ?? '')
              : undefined;
        if (!expectedPath || entry.path !== expectedPath) {
          fail(`Unexpected backup entry ${entry.path}`);
        }
        if (seen.has(entry.path)) fail(`Duplicate backup entry ${entry.path}`);
        seen.add(entry.path);

        if (entry.path === databasePath) {
          if (entry.size !== manifest.database.size)
            fail('Database dump size does not match manifest');
          const source = checkedSource(
            entry.bytes,
            manifest.database.size,
            manifest.database.sha256,
            databasePath,
          );
          if (mode.mode === 'extract-database')
            await pipeline(Readable.from(source), mode.destination);
          else await drain(source);
        } else {
          const object = manifest.objects[entryIndex - 2];
          if (!object || entry.size !== object.size) fail('Object size does not match manifest');
          const source = checkedSource(entry.bytes, object.size, object.sha256, object.key);
          if (mode.mode === 'restore-local') {
            await writeLocalObject(mode.configuration, object.key, source);
            mode.written.push(object.key);
          } else {
            await drain(source);
          }
        }
        entryIndex += 1;
      },
      { maximumEntries: 1_000_002, maximumTotalBytes: maximumArchiveBytes },
    );
  } catch (error) {
    if (error instanceof MaintenanceBackupError) throw error;
    if (error instanceof MaintenanceArchiveError) {
      throw new MaintenanceBackupError(error.message, { cause: error });
    }
    throw error;
  }
  if (!manifest) fail('Backup manifest is missing');
  const expectedEntries = 2 + (manifest.storage.backend === 'local' ? manifest.objects.length : 0);
  if (entryIndex !== expectedEntries) fail('Backup archive is incomplete');
  return manifest;
}

function parseManifest(bytes: Buffer): BackupManifestV1 {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('Backup manifest is not valid JSON');
  }
  if (!record(value) || value.format !== backupFormat || value.version !== backupVersion) {
    fail('Backup format or version is unsupported');
  }
  if (
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !record(value.database) ||
    value.database.path !== databasePath ||
    value.database.format !== 'postgresql-custom' ||
    typeof value.database.sha256 !== 'string' ||
    !checksumPattern.test(value.database.sha256) ||
    !validSize(value.database.size) ||
    !Array.isArray(value.database.migrations) ||
    !value.database.migrations.every((item) => typeof item === 'string') ||
    !record(value.storage) ||
    (value.storage.backend !== 'local' && value.storage.backend !== 's3') ||
    value.storage.mode !== (value.storage.backend === 'local' ? 'bundled' : 'referenced') ||
    !Array.isArray(value.objects)
  ) {
    fail('Backup manifest is invalid');
  }
  const objects = value.objects.map(parseObject);
  if (objects.some((object, index) => index > 0 && object.key <= (objects[index - 1]?.key ?? ''))) {
    fail('Backup object inventory must be unique and sorted');
  }
  return {
    format: backupFormat,
    version: backupVersion,
    createdAt: value.createdAt,
    database: {
      path: databasePath,
      format: 'postgresql-custom',
      size: value.database.size,
      sha256: value.database.sha256,
      migrations: value.database.migrations,
    },
    storage: {
      backend: value.storage.backend,
      mode: value.storage.backend === 'local' ? 'bundled' : 'referenced',
    },
    objects,
  };
}

function parseObject(value: unknown): BackupObjectV1 {
  if (
    !record(value) ||
    typeof value.key !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !validSize(value.size)
  ) {
    fail('Backup object inventory is invalid');
  }
  const object = { key: value.key, size: value.size, sha256: value.sha256 };
  validateObject(object);
  return object;
}

function validateObject(object: BackupObjectV1): void {
  const match = objectKeyPattern.exec(object.key);
  if (
    !match ||
    match[1] !== object.sha256.slice(0, 2) ||
    match[2] !== object.sha256.slice(2, 4) ||
    match[3] !== object.sha256 ||
    !checksumPattern.test(object.sha256) ||
    !validSize(object.size)
  ) {
    fail(`Stored object metadata is invalid for ${object.key}`);
  }
}

async function assertObject(blobs: BlobStore, object: BackupObjectV1): Promise<void> {
  validateObject(object);
  const result = await blobs.verify(object.key, {
    checksum: object.sha256,
    size: object.size,
  });
  if (result.status !== 'ok') {
    throw new MaintenanceBackupError(
      `Stored object ${object.key} failed integrity: ${result.status}`,
    );
  }
}

async function inspectFile(
  path: string,
): Promise<{ readonly size: number; readonly sha256: string }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new MaintenanceBackupError('PostgreSQL dump must be a regular file');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: info.size, sha256: hash.digest('hex') };
}

async function* checkedSource(
  source: AsyncIterable<Uint8Array>,
  expectedSize: number,
  expectedChecksum: string,
  label: string,
): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of source) {
    hash.update(chunk);
    size += chunk.byteLength;
    if (size > expectedSize) fail(`${label} exceeds its declared size`);
    yield chunk;
  }
  if (size !== expectedSize || hash.digest('hex') !== expectedChecksum) {
    fail(`${label} failed checksum verification`);
  }
}

async function writeLocalObject(
  configuration: LocalStorageConfiguration,
  key: string,
  source: AsyncIterable<Uint8Array>,
): Promise<void> {
  const destination = localObjectPath(configuration, key);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.restore`;
  try {
    await pipeline(
      Readable.from(source),
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function assertCleanLocalStorage(configuration: LocalStorageConfiguration): Promise<void> {
  await LocalBlobStore.create(configuration.root);
  for (const directory of ['objects', 'staging']) {
    if ((await readdir(resolve(configuration.root, directory), { recursive: true })).length > 0) {
      throw new MaintenanceBackupError('Local storage target is not clean');
    }
  }
}

function localObjectPath(configuration: LocalStorageConfiguration, key: string): string {
  validateObjectKey(key);
  const root = resolve(configuration.root);
  const path = resolve(root, key);
  if (!path.startsWith(`${root}${sep}`)) fail('Stored object key escapes the local storage root');
  return path;
}

function archiveObjectPath(key: string): string {
  const match = objectKeyPattern.exec(key);
  if (!match || match[1] !== match[3]?.slice(0, 2) || match[2] !== match[3]?.slice(2, 4)) {
    fail(`Stored object key is invalid: ${key}`);
  }
  return `blobs/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
}

function validateObjectKey(key: string): void {
  const match = objectKeyPattern.exec(key);
  if (!match || match[1] !== match[3]?.slice(0, 2) || match[2] !== match[3]?.slice(2, 4)) {
    fail(`Stored object key is invalid: ${key}`);
  }
}

function assertBackend(manifest: BackupManifestV1, storage: StorageConfiguration): void {
  if (manifest.storage.backend !== storage.backend) {
    throw new MaintenanceBackupError(
      `Backup uses ${manifest.storage.backend} storage but this installation uses ${storage.backend}`,
    );
  }
}

function safeSize(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!validSize(parsed)) throw new MaintenanceBackupError('Stored object size is invalid');
  return parsed;
}

function validSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function collect(source: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > limit) fail('Backup manifest is too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function drain(source: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _chunk of source) {
    // Integrity is checked by checkedSource.
  }
}

async function* single(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

function fail(message: string): never {
  throw new MaintenanceBackupError(message);
}
