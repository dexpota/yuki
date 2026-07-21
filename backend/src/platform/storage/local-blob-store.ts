import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  type BlobMetadata,
  type BlobStore,
  BlobStoreError,
  type ByteRange,
  type CommittedBlob,
  type IntegrityResult,
  InvalidBlobKeyError,
  type StagedBlob,
} from './blob-store.js';

const checksumPattern = /^[a-f0-9]{64}$/;
const stageKeyPattern = /^[a-f0-9-]{36}$/;
const objectKeyPattern = /^objects\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{64})-([a-f0-9-]{36})$/;

/** Local BlobStore. The root must be a dedicated volume, not a user-controlled tree. */
export class LocalBlobStore implements BlobStore {
  readonly #root: string;
  readonly #stagingRoot: string;
  readonly #objectsRoot: string;

  private constructor(root: string) {
    this.#root = root;
    this.#stagingRoot = resolve(root, 'staging');
    this.#objectsRoot = resolve(root, 'objects');
  }

  static async create(root: string): Promise<LocalBlobStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(root);
    const store = new LocalBlobStore(canonicalRoot);
    await store.#createOwnedDirectory(store.#stagingRoot);
    await store.#createOwnedDirectory(store.#objectsRoot);
    return store;
  }

  async stage(source: AsyncIterable<Uint8Array>): Promise<StagedBlob> {
    await this.#assertDirectory(this.#stagingRoot);
    const stageKey = randomUUID();
    const path = this.#stagePath(stageKey);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.byteLength;
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.from(source),
        meter,
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      );
      const handle = await open(path, constants.O_RDONLY | noFollowFlag());
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { stageKey, checksum: hash.digest('hex'), size };
    } catch (error) {
      await rm(path, { force: true });
      throw new BlobStoreError(`Could not stage blob: ${errorMessage(error)}`, { cause: error });
    }
  }

  async commit(staged: StagedBlob): Promise<CommittedBlob> {
    await this.#assertDirectory(this.#stagingRoot);
    this.#assertStageKey(staged.stageKey);
    this.#assertDigest(staged.checksum);
    this.#assertSize(staged.size);
    const source = this.#stagePath(staged.stageKey);
    await this.#assertRegularFile(source);

    const actual = await this.#hashFile(source);
    if (actual.checksum !== staged.checksum || actual.size !== staged.size) {
      throw new BlobStoreError('Staged blob metadata does not match its content');
    }

    const suffix = randomUUID();
    const key = `objects/${staged.checksum.slice(0, 2)}/${staged.checksum.slice(2, 4)}/${staged.checksum}-${suffix}`;
    const destination = this.#objectPath(key);
    await this.#createOwnedDirectory(dirname(destination));
    await rename(source, destination);
    await syncDirectory(dirname(destination));
    return { key, checksum: staged.checksum, size: staged.size };
  }

  async discard(staged: Pick<StagedBlob, 'stageKey'>): Promise<void> {
    await this.#assertDirectory(this.#stagingRoot);
    this.#assertStageKey(staged.stageKey);
    await rm(this.#stagePath(staged.stageKey), { force: true });
  }

  async read(key: string, range?: ByteRange): Promise<Readable> {
    const path = this.#objectPath(key);
    const metadata = await this.head(key);
    if (!metadata) throw new BlobStoreError('Blob does not exist');
    const normalizedRange = validateRange(range, metadata.size);
    const handle = await open(path, constants.O_RDONLY | noFollowFlag());
    return handle.createReadStream({
      autoClose: true,
      ...(normalizedRange ?? {}),
    });
  }

  async head(key: string): Promise<BlobMetadata | undefined> {
    const match = this.#matchObjectKey(key);
    const path = this.#objectPath(key);
    try {
      await this.#assertObjectParents(path);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink())
        throw new BlobStoreError('Blob is not a regular file');
      return { key, checksum: match[3] as string, size: info.size };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== undefined;
  }

  async delete(key: string): Promise<void> {
    const path = this.#objectPath(key);
    try {
      await this.#assertObjectParents(path);
      await this.#assertRegularFile(path);
      await rm(path);
      await syncDirectory(dirname(path));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async verify(
    key: string,
    expected: Pick<BlobMetadata, 'checksum' | 'size'>,
  ): Promise<IntegrityResult> {
    this.#assertDigest(expected.checksum);
    this.#assertSize(expected.size);
    const metadata = await this.head(key);
    if (!metadata) return { status: 'missing' };
    const actual = await this.#hashFile(this.#objectPath(key));
    if (actual.size !== expected.size) {
      return { status: 'size_mismatch', expected, actual };
    }
    if (actual.checksum !== expected.checksum) {
      return { status: 'checksum_mismatch', expected, actual };
    }
    return { status: 'ok', metadata: { key, ...actual } };
  }

  async createSignedDownload(key: string, expiresAt: Date): Promise<undefined> {
    await this.head(key);
    if (!Number.isFinite(expiresAt.getTime()))
      throw new BlobStoreError('Download expiry is invalid');
    // Local objects are served through the authenticated streaming HTTP route.
    return undefined;
  }

  #stagePath(stageKey: string): string {
    this.#assertStageKey(stageKey);
    return this.#withinRoot(this.#stagingRoot, stageKey);
  }

  #objectPath(key: string): string {
    this.#matchObjectKey(key);
    return this.#withinRoot(this.#root, key);
  }

  #withinRoot(parent: string, child: string): string {
    const path = resolve(parent, child);
    if (!path.startsWith(`${parent}${sep}`))
      throw new InvalidBlobKeyError('Blob key escapes storage root');
    return path;
  }

  #matchObjectKey(key: string): RegExpExecArray {
    const match = objectKeyPattern.exec(key);
    if (!match || match[1] !== match[3]?.slice(0, 2) || match[2] !== match[3]?.slice(2, 4)) {
      throw new InvalidBlobKeyError('Invalid local blob key');
    }
    return match;
  }

  #assertStageKey(stageKey: string): void {
    if (!stageKeyPattern.test(stageKey)) throw new InvalidBlobKeyError('Invalid staging key');
  }

  #assertDigest(checksum: string): void {
    if (!checksumPattern.test(checksum))
      throw new BlobStoreError('Checksum must be lowercase SHA-256');
  }

  #assertSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) throw new BlobStoreError('Blob size is invalid');
  }

  async #createOwnedDirectory(path: string): Promise<void> {
    const relative = path.slice(this.#root.length + 1);
    let cursor = this.#root;
    for (const segment of relative.split(sep)) {
      cursor = resolve(cursor, segment);
      try {
        const info = await lstat(cursor);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new BlobStoreError('Storage path contains a non-directory or symbolic link');
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        await mkdir(cursor, { mode: 0o700 });
      }
    }
  }

  async #assertRegularFile(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new BlobStoreError('Blob is not a regular file');
  }

  async #assertDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new BlobStoreError('Storage path contains a non-directory or symbolic link');
    }
  }

  async #assertObjectParents(path: string): Promise<void> {
    await this.#assertDirectory(this.#objectsRoot);
    const parent = dirname(path);
    const relative = parent.slice(this.#objectsRoot.length + 1);
    let cursor = this.#objectsRoot;
    for (const segment of relative.split(sep)) {
      cursor = resolve(cursor, segment);
      await this.#assertDirectory(cursor);
    }
  }

  async #hashFile(path: string): Promise<Pick<BlobMetadata, 'checksum' | 'size'>> {
    await this.#assertRegularFile(path);
    const hash = createHash('sha256');
    let size = 0;
    const handle = await open(path, constants.O_RDONLY | noFollowFlag());
    const source = handle.createReadStream({ autoClose: true });
    for await (const chunk of source) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      size += bytes.byteLength;
    }
    return { checksum: hash.digest('hex'), size };
  }
}

function validateRange(
  range: ByteRange | undefined,
  size: number,
): { start: number; end?: number } | undefined {
  if (!range) return undefined;
  const { start, end } = range;
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
    throw new BlobStoreError('Byte range start is outside the blob');
  }
  if (end !== undefined && (!Number.isSafeInteger(end) || end < start || end >= size)) {
    throw new BlobStoreError('Byte range end is outside the blob');
  }
  return end === undefined ? { start } : { start, end };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
