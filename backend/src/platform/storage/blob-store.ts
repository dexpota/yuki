import type { Readable } from 'node:stream';

export interface StagedBlob {
  /** Opaque, short-lived handle. Feature code must not inspect or construct it. */
  readonly stageKey: string;
  readonly checksum: string;
  readonly size: number;
}

export interface CommittedBlob {
  /** Opaque backend key. Feature code persists but never constructs this value. */
  readonly key: string;
  readonly checksum: string;
  readonly size: number;
}

export interface BlobMetadata {
  readonly key: string;
  readonly checksum: string;
  readonly size: number;
}

export interface ByteRange {
  readonly start: number;
  /** Inclusive. */
  readonly end?: number;
}

export type IntegrityResult =
  | { readonly status: 'ok'; readonly metadata: BlobMetadata }
  | { readonly status: 'missing' }
  | {
      readonly status: 'size_mismatch' | 'checksum_mismatch';
      readonly expected: Pick<BlobMetadata, 'checksum' | 'size'>;
      readonly actual: Pick<BlobMetadata, 'checksum' | 'size'>;
    };

export interface BlobStore {
  stage(source: AsyncIterable<Uint8Array>): Promise<StagedBlob>;
  commit(staged: StagedBlob): Promise<CommittedBlob>;
  discard(staged: Pick<StagedBlob, 'stageKey'>): Promise<void>;
  read(key: string, range?: ByteRange): Promise<Readable>;
  head(key: string): Promise<BlobMetadata | undefined>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  verify(key: string, expected: Pick<BlobMetadata, 'checksum' | 'size'>): Promise<IntegrityResult>;
  /** Local proxy-backed stores return undefined; object stores may return a short-lived URL. */
  createSignedDownload(key: string, expiresAt: Date): Promise<URL | undefined>;
}

export class BlobStoreError extends Error {
  override readonly name: string = 'BlobStoreError';
}

export class InvalidBlobKeyError extends BlobStoreError {
  override readonly name = 'InvalidBlobKeyError';
}
