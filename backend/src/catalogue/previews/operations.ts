import type { Readable } from 'node:stream';

import type { Kysely } from 'kysely';

import { enqueueJob } from '../../platform/jobs/index.js';
import type { BlobStore } from '../../platform/storage/index.js';
import type { PreviewDatabaseSchema, PreviewGenerationResult } from './contracts.js';
import type { CataloguePreviewService } from './service.js';

export const previewJobType = 'catalogue.preview.generate';
export const previewPayloadVersion = 1;

export interface PreviewGenerator {
  generate(input: {
    readonly format: 'stl' | '3mf' | 'obj' | 'step' | 'gcode';
    readonly filename: string;
    readonly size: number;
    readonly open: () => Promise<Readable>;
  }): Promise<PreviewGenerationResult>;
}

export class CataloguePreviewNotFoundError extends Error {
  override readonly name = 'CataloguePreviewNotFoundError';
}

export class CataloguePreviewUnavailableError extends Error {
  override readonly name = 'CataloguePreviewUnavailableError';
}

export class CataloguePreviewOperations {
  constructor(
    private readonly database: Kysely<PreviewDatabaseSchema>,
    private readonly blobStore: BlobStore,
    private readonly previews: CataloguePreviewService,
  ) {}

  async request(ownerId: string, sourceAssetId: string) {
    const format = await this.sourceFormat(ownerId, sourceAssetId);
    if (!isPreviewFormat(format))
      throw new CataloguePreviewUnavailableError('This asset format cannot be previewed.');
    await requestPreviewGeneration(this.database, this.previews, ownerId, sourceAssetId, format);
    return this.previews.forAsset(ownerId, sourceAssetId);
  }

  async list(ownerId: string, sourceAssetId: string) {
    await this.sourceFormat(ownerId, sourceAssetId);
    return this.previews.forAsset(ownerId, sourceAssetId);
  }

  async download(
    ownerId: string,
    artifactId: string,
  ): Promise<{
    readonly filename: string;
    readonly mimeType: string;
    readonly byteSize: number;
    readonly stream: Readable;
  }> {
    const row = await this.database
      .selectFrom('catalogue_generated_artifacts as artifact')
      .innerJoin('catalogue_assets as asset', 'asset.id', 'artifact.source_asset_id')
      .innerJoin('catalogue_models as model', 'model.id', 'asset.model_id')
      .leftJoin('stored_objects as object', 'object.id', 'artifact.stored_object_id')
      .select([
        'artifact.kind',
        'artifact.status',
        'artifact.mime_type',
        'artifact.byte_size',
        'object.object_key',
      ])
      .where('artifact.id', '=', artifactId)
      .where('artifact.owner_id', '=', ownerId)
      .where('model.owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new CataloguePreviewNotFoundError('Preview artifact does not exist.');
    if (row.status !== 'ready' || !row.mime_type || row.byte_size === null || !row.object_key)
      throw new CataloguePreviewUnavailableError('Preview artifact is not ready.');
    const byteSize = checkedSize(row.byte_size);
    return {
      filename: artifactFilename(row.kind),
      mimeType: row.mime_type,
      byteSize,
      stream: await this.blobStore.read(row.object_key),
    };
  }

  private async sourceFormat(ownerId: string, sourceAssetId: string): Promise<string> {
    const source = await this.database
      .selectFrom('catalogue_assets as asset')
      .innerJoin('catalogue_models as model', 'model.id', 'asset.model_id')
      .select('asset.format')
      .where('asset.id', '=', sourceAssetId)
      .where('model.owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!source) throw new CataloguePreviewNotFoundError('Catalogue asset does not exist.');
    return source.format;
  }
}

export async function requestPreviewGeneration(
  database: Kysely<PreviewDatabaseSchema>,
  previews: CataloguePreviewService,
  ownerId: string,
  sourceAssetId: string,
  format: 'stl' | '3mf' | 'obj' | 'step' | 'gcode',
  generator = 'yuki-preview',
  generatorVersion = '1',
): Promise<readonly string[]> {
  const kinds =
    format === 'gcode'
      ? (['toolpath_preview'] as const)
      : (['geometry_preview', 'thumbnail'] as const);
  const artifacts = [];
  for (const kind of kinds)
    artifacts.push(
      await previews.request(ownerId, { sourceAssetId, kind, generator, generatorVersion }),
    );
  await enqueueJob(database, {
    type: previewJobType,
    payloadVersion: previewPayloadVersion,
    payload: { ownerId, sourceAssetId, artifactIds: artifacts.map((artifact) => artifact.id) },
    idempotencyKey: `${sourceAssetId}:${generator}:${generatorVersion}`,
  });
  return artifacts.map((artifact) => artifact.id);
}

function isPreviewFormat(value: string): value is 'stl' | '3mf' | 'obj' | 'step' | 'gcode' {
  return ['stl', '3mf', 'obj', 'step', 'gcode'].includes(value);
}

function checkedSize(value: string | number): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Preview artifact size is invalid.');
  return size;
}

function artifactFilename(kind: 'geometry_preview' | 'thumbnail' | 'toolpath_preview'): string {
  if (kind === 'geometry_preview') return 'preview.glb';
  if (kind === 'thumbnail') return 'thumbnail.svg';
  return 'layers.json';
}
