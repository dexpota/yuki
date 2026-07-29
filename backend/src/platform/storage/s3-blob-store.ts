import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
const stageKeyPattern = /^staging\/[a-f0-9-]{36}$/;
const objectKeyPattern = /^objects\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{64})-([a-f0-9-]{36})$/;

export interface S3BlobStoreOptions {
  readonly bucket: string;
  readonly multipartThresholdBytes: number;
  readonly signedDownloadTtlSeconds: number;
}

/** Vendor-neutral S3 BlobStore. Bucket access is private and keys are never caller-defined. */
export class S3BlobStore implements BlobStore {
  public constructor(
    private readonly client: S3Client,
    private readonly options: S3BlobStoreOptions,
  ) {}

  public async checkAccess(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
    } catch (error) {
      throw storageError('Could not access S3 bucket', error);
    }
  }

  public async stage(source: AsyncIterable<Uint8Array>): Promise<StagedBlob> {
    const stageKey = `staging/${randomUUID()}`;
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.byteLength;
        callback(null, chunk);
      },
    });
    const input = Readable.from(source);
    input.on('error', (error) => meter.destroy(error));
    input.pipe(meter);
    try {
      await new Upload({
        client: this.client,
        params: { Bucket: this.options.bucket, Key: stageKey, Body: meter },
        queueSize: 2,
        partSize: this.options.multipartThresholdBytes,
        leavePartsOnError: false,
      }).done();
      return { stageKey, checksum: hash.digest('hex'), size };
    } catch (error) {
      await this.#delete(stageKey).catch(() => {});
      throw storageError('Could not stage S3 blob', error);
    }
  }

  public async commit(staged: StagedBlob): Promise<CommittedBlob> {
    this.#stageKey(staged.stageKey);
    digest(staged.checksum);
    size(staged.size);
    const actual = await this.#digestObject(staged.stageKey);
    if (actual.checksum !== staged.checksum || actual.size !== staged.size) {
      throw new BlobStoreError('Staged blob metadata does not match its content');
    }
    const key = `objects/${staged.checksum.slice(0, 2)}/${staged.checksum.slice(2, 4)}/${staged.checksum}-${randomUUID()}`;
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          CopySource: `${encodeURIComponent(this.options.bucket)}/${encodeKey(staged.stageKey)}`,
          MetadataDirective: 'REPLACE',
          Metadata: { 'yuki-sha256': staged.checksum },
        }),
      );
      const metadata = await this.head(key);
      if (!metadata || metadata.size !== staged.size || metadata.checksum !== staged.checksum) {
        await this.#delete(key);
        throw new BlobStoreError('Committed S3 blob metadata does not match staged content');
      }
      await this.#delete(staged.stageKey);
      return { key, checksum: staged.checksum, size: staged.size };
    } catch (error) {
      await this.#delete(key).catch(() => {});
      if (error instanceof BlobStoreError) throw error;
      throw storageError('Could not commit S3 blob', error);
    }
  }

  public async discard(staged: Pick<StagedBlob, 'stageKey'>): Promise<void> {
    this.#stageKey(staged.stageKey);
    await this.#delete(staged.stageKey);
  }

  public async read(key: string, range?: ByteRange): Promise<Readable> {
    this.#objectKey(key);
    const metadata = await this.head(key);
    if (!metadata) throw new BlobStoreError('Blob does not exist');
    const normalized = validateRange(range, metadata.size);
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          ...(normalized ? { Range: normalized } : {}),
        }),
      );
      if (!response.Body) throw new BlobStoreError('S3 returned an empty response body');
      return Readable.fromWeb(response.Body.transformToWebStream());
    } catch (error) {
      if (error instanceof BlobStoreError) throw error;
      throw storageError('Could not read S3 blob', error);
    }
  }

  public async head(key: string): Promise<BlobMetadata | undefined> {
    const match = this.#objectKey(key);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      const checksum = match[3] as string;
      if (response.Metadata?.['yuki-sha256'] !== checksum) {
        throw new BlobStoreError('S3 blob checksum metadata is missing or invalid');
      }
      if (response.ContentLength === undefined) {
        throw new BlobStoreError('S3 blob size metadata is missing');
      }
      return { key, checksum, size: response.ContentLength };
    } catch (error) {
      if (notFound(error)) return undefined;
      if (error instanceof BlobStoreError) throw error;
      throw storageError('Could not inspect S3 blob', error);
    }
  }

  public async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== undefined;
  }

  public async delete(key: string): Promise<void> {
    this.#objectKey(key);
    await this.#delete(key);
  }

  public async verify(
    key: string,
    expected: Pick<BlobMetadata, 'checksum' | 'size'>,
  ): Promise<IntegrityResult> {
    digest(expected.checksum);
    size(expected.size);
    const metadata = await this.head(key);
    if (!metadata) return { status: 'missing' };
    const actual = await this.#digestObject(key);
    if (actual.size !== expected.size) return { status: 'size_mismatch', expected, actual };
    if (actual.checksum !== expected.checksum)
      return { status: 'checksum_mismatch', expected, actual };
    return { status: 'ok', metadata: { key, ...actual } };
  }

  public async createSignedDownload(key: string, expiresAt: Date): Promise<URL> {
    this.#objectKey(key);
    if (!(await this.exists(key))) throw new BlobStoreError('Blob does not exist');
    const seconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      seconds < 1 ||
      seconds > this.options.signedDownloadTtlSeconds
    ) {
      throw new BlobStoreError('Download expiry is invalid');
    }
    const value = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      { expiresIn: seconds },
    );
    return new URL(value);
  }

  async #digestObject(key: string): Promise<Pick<BlobMetadata, 'checksum' | 'size'>> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      if (!response.Body) throw new BlobStoreError('S3 returned an empty response body');
      const hash = createHash('sha256');
      let total = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        total += chunk.byteLength;
      }
      return { checksum: hash.digest('hex'), size: total };
    } catch (error) {
      if (error instanceof BlobStoreError) throw error;
      throw storageError('Could not verify S3 blob', error);
    }
  }

  async #delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
    } catch (error) {
      throw storageError('Could not delete S3 blob', error);
    }
  }

  #stageKey(key: string): void {
    if (!stageKeyPattern.test(key)) throw new InvalidBlobKeyError('Invalid S3 staging key');
  }

  #objectKey(key: string): RegExpExecArray {
    const match = objectKeyPattern.exec(key);
    if (!match || match[1] !== match[3]?.slice(0, 2) || match[2] !== match[3]?.slice(2, 4)) {
      throw new InvalidBlobKeyError('Invalid S3 blob key');
    }
    return match;
  }
}

function validateRange(range: ByteRange | undefined, objectSize: number): string | undefined {
  if (!range) return undefined;
  if (!Number.isSafeInteger(range.start) || range.start < 0 || range.start >= objectSize)
    throw new BlobStoreError('Byte range start is outside the blob');
  if (
    range.end !== undefined &&
    (!Number.isSafeInteger(range.end) || range.end < range.start || range.end >= objectSize)
  )
    throw new BlobStoreError('Byte range end is outside the blob');
  return `bytes=${range.start}-${range.end ?? ''}`;
}

function digest(value: string): void {
  if (!checksumPattern.test(value)) throw new BlobStoreError('Checksum must be lowercase SHA-256');
}

function size(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new BlobStoreError('Blob size is invalid');
}

function encodeKey(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function notFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (('name' in error && (error.name === 'NotFound' || error.name === 'NoSuchKey')) ||
      ('$metadata' in error &&
        typeof error.$metadata === 'object' &&
        error.$metadata !== null &&
        'httpStatusCode' in error.$metadata &&
        error.$metadata.httpStatusCode === 404))
  );
}

function storageError(message: string, cause: unknown): BlobStoreError {
  return new BlobStoreError(message, { cause });
}
