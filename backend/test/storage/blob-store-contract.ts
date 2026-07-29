import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import { expect } from 'vitest';

import {
  type BlobStore,
  BlobStoreError,
  InvalidBlobKeyError,
} from '../../src/platform/storage/index.js';

export async function verifyBlobStoreContract(
  store: BlobStore,
  options: { readonly signedDownloads: boolean },
): Promise<void> {
  const content = Buffer.concat([
    Buffer.alloc(5 * 1024 * 1024, 0x59),
    Buffer.from('uki multipart boundary'),
  ]);
  const expectedChecksum = createHash('sha256').update(content).digest('hex');
  const staged = await store.stage(chunks(content, 257 * 1024));
  expect(staged).toMatchObject({ checksum: expectedChecksum, size: content.byteLength });
  const committed = await store.commit(staged);
  expect(committed.key).toMatch(/^objects\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}-[a-f0-9-]{36}$/);
  expect(await store.head(committed.key)).toEqual(committed);
  expect(await store.exists(committed.key)).toBe(true);
  expect(await bytes(await store.read(committed.key, { start: 4, end: 12 }))).toEqual(
    content.subarray(4, 13),
  );
  expect(await store.verify(committed.key, committed)).toEqual({
    status: 'ok',
    metadata: committed,
  });
  const signed = await store.createSignedDownload(committed.key, new Date(Date.now() + 30_000));
  expect(options.signedDownloads ? signed instanceof URL : signed === undefined).toBe(true);
  if (signed) {
    const response = await fetch(signed);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
  }

  await expect(store.head('../escape')).rejects.toBeInstanceOf(InvalidBlobKeyError);
  await expect(store.read(committed.key, { start: content.length })).rejects.toBeInstanceOf(
    BlobStoreError,
  );
  await store.delete(committed.key);
  expect(await store.exists(committed.key)).toBe(false);
  expect(await store.verify(committed.key, committed)).toEqual({ status: 'missing' });
  await expect(store.delete(committed.key)).resolves.toBeUndefined();
  await expect(store.stage(failingChunks())).rejects.toBeInstanceOf(BlobStoreError);
}

async function* failingChunks(): AsyncGenerator<Uint8Array> {
  yield Buffer.alloc(5 * 1024 * 1024, 0x58);
  throw new Error('contract stream failure');
}

async function* chunks(content: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < content.length; offset += size) {
    yield content.subarray(offset, Math.min(content.length, offset + size));
  }
}

async function bytes(stream: Readable): Promise<Buffer> {
  const values: Buffer[] = [];
  for await (const chunk of stream) values.push(Buffer.from(chunk));
  return Buffer.concat(values);
}
