import { createHash } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { InvalidBlobKeyError, LocalBlobStore } from '../../src/platform/storage/index.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalBlobStore', () => {
  it('streams, hashes and atomically commits content under an opaque key', async () => {
    const { root, store } = await makeStore();
    let emitted = 0;
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (const value of ['large ', 'original ', 'asset']) {
        emitted += 1;
        yield Buffer.from(value);
      }
    }

    const staged = await store.stage(chunks());
    expect(emitted).toBe(3);
    expect(staged).toMatchObject({
      checksum: createHash('sha256').update('large original asset').digest('hex'),
      size: 20,
    });
    const committed = await store.commit(staged);

    expect(committed.key).toMatch(/^objects\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}-/);
    expect(await readStream(await store.read(committed.key))).toBe('large original asset');
    await expect(readFile(join(root, 'staging', staged.stageKey))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('supports inclusive byte ranges and validates their bounds', async () => {
    const { store } = await makeStore();
    const committed = await store.commit(
      await store.stage(Readable.from([Buffer.from('0123456789')])),
    );

    expect(await readStream(await store.read(committed.key, { start: 2, end: 5 }))).toBe('2345');
    await expect(store.read(committed.key, { start: 10 })).rejects.toThrow('outside the blob');
    await expect(store.read(committed.key, { start: 5, end: 4 })).rejects.toThrow(
      'outside the blob',
    );
  });

  it('reports missing, size and checksum integrity failures without changing content', async () => {
    const { root, store } = await makeStore();
    const committed = await store.commit(
      await store.stage(Readable.from([Buffer.from('original')])),
    );

    expect(await store.verify(committed.key, committed)).toMatchObject({ status: 'ok' });
    await writeFile(join(root, committed.key), 'changed!');
    expect(await store.verify(committed.key, committed)).toMatchObject({
      status: 'checksum_mismatch',
    });
    await writeFile(join(root, committed.key), 'short');
    expect(await store.verify(committed.key, committed)).toMatchObject({ status: 'size_mismatch' });
    await store.delete(committed.key);
    expect(await store.verify(committed.key, committed)).toEqual({ status: 'missing' });
    await expect(store.delete(committed.key)).resolves.toBeUndefined();
    await expect(store.createSignedDownload(committed.key, new Date())).resolves.toBeUndefined();
  });

  it('rejects constructed traversal keys and symbolic-link path components', async () => {
    const { root, store } = await makeStore();
    await expect(store.head('../../etc/passwd')).rejects.toBeInstanceOf(InvalidBlobKeyError);
    await expect(store.discard({ stageKey: '../outside' })).rejects.toBeInstanceOf(
      InvalidBlobKeyError,
    );

    const checksum = 'a'.repeat(64);
    await mkdir(join(root, 'outside'), { recursive: true });
    await symlink(join(root, 'outside'), join(root, 'objects', 'aa'));
    const forgedKey = `objects/aa/aa/${checksum}-00000000-0000-4000-8000-000000000000`;
    await expect(store.head(forgedKey)).rejects.toThrow('symbolic link');
  });

  it('refuses a commit when staged content was changed after hashing', async () => {
    const { root, store } = await makeStore();
    const staged = await store.stage(Readable.from([Buffer.from('trusted')]));
    await writeFile(join(root, 'staging', staged.stageKey), 'altered');
    await expect(store.commit(staged)).rejects.toThrow('does not match');
  });
});

async function makeStore(): Promise<{ root: string; store: LocalBlobStore }> {
  const { mkdtemp } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'yuki-storage-'));
  roots.push(root);
  return { root, store: await LocalBlobStore.create(root) };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let result = '';
  for await (const chunk of stream) result += Buffer.from(chunk).toString('utf8');
  return result;
}
