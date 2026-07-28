import type { Readable } from 'node:stream';

import type { Kysely } from 'kysely';

import type { BlobStore, ByteRange } from '../platform/storage/index.js';
import type { CatalogueDatabaseSchema } from './schema.js';

export class CatalogueAssetNotFoundError extends Error {
  override readonly name = 'CatalogueAssetNotFoundError';
}

export class CatalogueAssetUnavailableError extends Error {
  override readonly name = 'CatalogueAssetUnavailableError';
}

export interface CatalogueAssetDownload {
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly checksum: string;
  readonly range: { readonly start: number; readonly end: number } | null;
  readonly stream: Readable;
}

export class CatalogueAssetDownloads {
  public constructor(
    private readonly database: Kysely<CatalogueDatabaseSchema>,
    private readonly blobs: BlobStore,
  ) {}

  public async open(
    ownerId: string,
    assetId: string,
    requestedRange?: ByteRange,
  ): Promise<CatalogueAssetDownload> {
    const asset = await this.database
      .selectFrom('catalogue_assets as asset')
      .innerJoin('catalogue_models as model', 'model.id', 'asset.model_id')
      .innerJoin('stored_objects as object', 'object.id', 'asset.stored_object_id')
      .select([
        'asset.original_filename',
        'asset.detected_mime_type',
        'asset.byte_size',
        'asset.checksum',
        'object.object_key',
      ])
      .where('asset.id', '=', assetId)
      .where('asset.published_at', 'is not', null)
      .where('model.owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!asset) throw new CatalogueAssetNotFoundError('Catalogue asset does not exist.');
    const byteSize = checkedSize(asset.byte_size);
    const metadata = await this.blobs.head(asset.object_key);
    if (!metadata || metadata.size !== byteSize || metadata.checksum !== asset.checksum)
      throw new CatalogueAssetUnavailableError('Catalogue asset bytes are unavailable.');
    const range = requestedRange ? normalizedRange(requestedRange, byteSize) : null;
    return {
      filename: asset.original_filename,
      mimeType: asset.detected_mime_type,
      byteSize,
      checksum: asset.checksum,
      range,
      stream: await this.blobs.read(asset.object_key, range ?? undefined),
    };
  }
}

function checkedSize(value: string | number): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0)
    throw new CatalogueAssetUnavailableError('Catalogue asset metadata is invalid.');
  return size;
}

function normalizedRange(range: ByteRange, byteSize: number) {
  const end = range.end ?? byteSize - 1;
  if (
    byteSize === 0 ||
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(end) ||
    range.start < 0 ||
    end < range.start ||
    range.start >= byteSize
  )
    throw new CatalogueAssetRangeError(byteSize);
  return { start: range.start, end: Math.min(end, byteSize - 1) };
}

export class CatalogueAssetRangeError extends Error {
  override readonly name = 'CatalogueAssetRangeError';

  public constructor(public readonly byteSize: number) {
    super('Requested byte range is not satisfiable.');
  }
}
