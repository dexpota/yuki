import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type BackupManifestV1,
  backupFormat,
  backupVersion,
  extractDatabaseDump,
  restoreStorage,
  type TarEntry,
  verifyBackup,
  writeTar,
} from '../../src/platform/maintenance/index.js';
import { LocalBlobStore } from '../../src/platform/storage/index.js';

describe('maintenance backup packages', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
  });

  it('restores a representative local object and extracts the PostgreSQL dump', async () => {
    const root = await temporary('yuki-o03-target-');
    const dump = Buffer.from('representative PostgreSQL custom dump');
    const object = Buffer.from('representative model bytes');
    const archive = await packageBytes('local', dump, object);
    const store = await LocalBlobStore.create(root);

    const restored = await restoreStorage(chunks(archive, 37), store, {
      backend: 'local',
      root,
    });
    const restoredObject = restored.objects[0];
    expect(restoredObject).toBeDefined();
    expect(await collect(await store.read(restoredObject?.key as string))).toEqual(object);

    const dumpPath = join(await temporary('yuki-o03-dump-'), 'database.dump');
    await extractDatabaseDump(chunks(archive, 19), createWriteStream(dumpPath));
    expect(await readFile(dumpPath)).toEqual(dump);
  });

  it('rejects corrupt bundled bytes and leaves the clean target without objects', async () => {
    const root = await temporary('yuki-o03-corrupt-');
    const archive = await packageBytes(
      'local',
      Buffer.from('database'),
      Buffer.from('expected'),
      Buffer.from('tampered'),
    );
    const store = await LocalBlobStore.create(root);

    await expect(
      restoreStorage(chunks(archive, 11), store, { backend: 'local', root }),
    ).rejects.toThrow('failed checksum verification');
    expect(await readdir(join(root, 'objects'), { recursive: true })).toEqual([]);
  });

  it('refuses to restore over existing local objects', async () => {
    const root = await temporary('yuki-o03-dirty-');
    const store = await LocalBlobStore.create(root);
    const staged = await store.stage(chunks(Buffer.from('already here'), 3));
    await store.commit(staged);
    const archive = await packageBytes('local', Buffer.from('database'), Buffer.alloc(0));

    await expect(
      restoreStorage(chunks(archive, 64), store, { backend: 'local', root }),
    ).rejects.toThrow('not clean');
  });

  it('keeps S3 object bytes external while verifying the referenced inventory', async () => {
    const sourceRoot = await temporary('yuki-o03-s3-source-');
    const store = await LocalBlobStore.create(sourceRoot);
    const object = Buffer.from('external object');
    const staged = await store.stage(chunks(object, 4));
    const committed = await store.commit(staged);
    const archive = await packageBytes(
      's3',
      Buffer.from('database'),
      object,
      object,
      committed.key,
    );

    const manifest = await verifyBackup(chunks(archive, 23), store, {
      backend: 's3',
      endpoint: new URL('https://objects.example.test'),
      region: 'test-1',
      bucket: 'yuki-test',
      accessKeyId: 'unused',
      secretAccessKey: 'unused',
      forcePathStyle: true,
      multipartThresholdBytes: 5 * 1024 * 1024,
      signedDownloadTtlSeconds: 300,
    });
    expect(manifest.storage).toEqual({ backend: 's3', mode: 'referenced' });
    expect(manifest.objects).toHaveLength(1);
  });

  it('rejects unsafe archive paths before emitting a package', async () => {
    await expect(
      collect(
        writeTar(
          (async function* (): AsyncGenerator<TarEntry> {
            yield { path: '../outside', size: 0, source: chunks(Buffer.alloc(0), 1) };
          })(),
        ),
      ),
    ).rejects.toThrow('unsafe path');
  });

  async function temporary(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    directories.push(path);
    return path;
  }
});

async function packageBytes(
  backend: 'local' | 's3',
  dump: Buffer,
  expectedObject: Buffer,
  archivedObject = expectedObject,
  requestedKey?: string,
): Promise<Buffer> {
  const checksum = createHash('sha256').update(expectedObject).digest('hex');
  const key =
    requestedKey ??
    `objects/${checksum.slice(0, 2)}/${checksum.slice(2, 4)}/${checksum}-00000000-0000-4000-8000-000000000000`;
  const manifest: BackupManifestV1 = {
    format: backupFormat,
    version: backupVersion,
    createdAt: '2026-07-29T12:00:00.000Z',
    database: {
      path: 'database.dump',
      format: 'postgresql-custom',
      size: dump.length,
      sha256: createHash('sha256').update(dump).digest('hex'),
      migrations: ['0001_foundation'],
    },
    storage: {
      backend,
      mode: backend === 'local' ? 'bundled' : 'referenced',
    },
    objects: [{ key, size: expectedObject.length, sha256: checksum }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return collect(
    writeTar(
      (async function* (): AsyncGenerator<TarEntry> {
        yield {
          path: 'manifest.json',
          size: manifestBytes.length,
          source: chunks(manifestBytes, 17),
        };
        yield { path: 'database.dump', size: dump.length, source: chunks(dump, 5) };
        if (backend === 'local') {
          const suffix = key.slice(key.lastIndexOf('/') + checksum.length + 2);
          yield {
            path: `blobs/${checksum.slice(0, 2)}/${checksum.slice(2, 4)}/${checksum}/${suffix}`,
            size: archivedObject.length,
            source: chunks(archivedObject, 7),
          };
        }
      })(),
    ),
  );
}

async function* chunks(bytes: Buffer, size: number): AsyncGenerator<Uint8Array> {
  if (bytes.length === 0) return;
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
