import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';

import type { BlobStore, CommittedBlob, StagedBlob } from '../../platform/storage/index.js';
import type { CatalogueDatabaseSchema } from '../schema.js';
import {
  canonicalManifestJson,
  InvalidPortablePackageError,
  parseManifestV1,
  type YukiExportManifestV1,
} from './manifest.js';
import {
  DEFAULT_PORTABLE_ZIP_LIMITS,
  type PortableZipEntry,
  type PortableZipLimits,
  readPortableZip,
  writePortableZip,
} from './zip.js';

export interface CataloguePortabilityOptions {
  readonly storageBackend: string;
  readonly limits?: PortableZipLimits;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export class CataloguePortabilityService {
  readonly #limits: PortableZipLimits;
  readonly #now: () => Date;
  readonly #newId: () => string;

  public constructor(
    private readonly database: Kysely<CatalogueDatabaseSchema>,
    private readonly blobs: BlobStore,
    private readonly options: CataloguePortabilityOptions,
  ) {
    this.#limits = options.limits ?? DEFAULT_PORTABLE_ZIP_LIMITS;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
  }

  /** Produces the package lazily; database and blob reads start on iteration. */
  public exportModel(ownerId: string, modelId: string): AsyncIterable<Uint8Array> {
    return writePortableZip(this.#exportEntries(ownerId, modelId));
  }

  async *#exportEntries(ownerId: string, modelId: string): AsyncGenerator<PortableZipEntry> {
    const model = await this.database
      .selectFrom('catalogue_models')
      .selectAll()
      .where('id', '=', modelId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!model) throw new CataloguePortabilityNotFoundError('Model not found');
    const [versions, assets, tags, collections] = await Promise.all([
      this.database
        .selectFrom('catalogue_model_versions')
        .selectAll()
        .where('model_id', '=', modelId)
        .where('published_at', 'is not', null)
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .execute(),
      this.database
        .selectFrom('catalogue_assets as asset')
        .innerJoin('stored_objects as object', 'object.id', 'asset.stored_object_id')
        .select([
          'asset.id',
          'asset.model_version_id',
          'asset.role',
          'asset.format',
          'asset.original_filename',
          'asset.detected_mime_type',
          'asset.byte_size',
          'asset.checksum',
          'asset.imported_at',
          'object.object_key',
        ])
        .where('asset.model_id', '=', modelId)
        .where('asset.published_at', 'is not', null)
        .orderBy('asset.model_version_id', 'asc')
        .orderBy('asset.id', 'asc')
        .execute(),
      this.database
        .selectFrom('catalogue_model_tags as relation')
        .innerJoin('catalogue_tags as tag', 'tag.id', 'relation.tag_id')
        .select('tag.name')
        .where('relation.model_id', '=', modelId)
        .where('relation.owner_id', '=', ownerId)
        .orderBy('tag.normalized_name', 'asc')
        .execute(),
      this.database
        .selectFrom('catalogue_model_collections as relation')
        .innerJoin('catalogue_collections as collection', 'collection.id', 'relation.collection_id')
        .select(['collection.name', 'collection.description'])
        .where('relation.model_id', '=', modelId)
        .where('relation.owner_id', '=', ownerId)
        .orderBy('collection.normalized_name', 'asc')
        .execute(),
    ]);
    const paths = new Map(
      assets.map((asset) => [asset.id, `assets/${asset.model_version_id}/${asset.id}`]),
    );
    const manifest: YukiExportManifestV1 = {
      format: 'yuki-model-export',
      version: 1,
      model: {
        id: model.id,
        name: model.name,
        description: model.description,
        sourceUrl: model.source_url,
        creator: model.creator,
        license: model.license,
        favorite: model.favorite,
        currentVersionId: model.current_version_id,
        coverAssetId: model.cover_asset_id,
        createdAt: model.created_at.toISOString(),
        updatedAt: model.updated_at.toISOString(),
      },
      versions: versions.map((version) => ({
        id: version.id,
        label: version.label,
        changeNote: version.change_note,
        metadataSchemaVersion: version.metadata_schema_version,
        metadata: version.metadata_snapshot as Readonly<Record<string, unknown>>,
        createdAt: version.created_at.toISOString(),
        assetIds: assets
          .filter((asset) => asset.model_version_id === version.id)
          .map((asset) => asset.id),
      })),
      assets: assets.map((asset) => ({
        id: asset.id,
        versionId: asset.model_version_id,
        path: paths.get(asset.id) as string,
        role: asset.role,
        format: asset.format,
        originalFilename: asset.original_filename,
        detectedMimeType: asset.detected_mime_type,
        byteSize: byteSize(asset.byte_size),
        sha256: asset.checksum,
        importedAt: asset.imported_at.toISOString(),
      })),
      tags: tags.map((tag) => tag.name),
      collections,
      generatedArtifacts: [],
      printHistory: [],
    };
    parseManifestV1(manifest);
    const manifestBytes = Buffer.from(canonicalManifestJson(manifest));
    yield { path: 'manifest.json', size: manifestBytes.length, source: one(manifestBytes) };
    for (const asset of assets) {
      const metadata = await this.blobs.head(asset.object_key);
      if (
        !metadata ||
        metadata.checksum !== asset.checksum ||
        metadata.size !== byteSize(asset.byte_size)
      )
        throw new CataloguePortabilityIntegrityError('An original asset is missing or corrupt');
      yield {
        path: paths.get(asset.id) as string,
        size: metadata.size,
        source: await this.blobs.read(asset.object_key),
      };
    }
  }

  /** Validates and stages every byte before publishing any catalogue row. */
  public async importModel(
    ownerId: string,
    packageBytes: AsyncIterable<Uint8Array>,
    options: { readonly modelId?: string } = {},
  ): Promise<{ readonly modelId: string }> {
    let manifest: YukiExportManifestV1 | undefined;
    const staged = new Map<string, StagedBlob>();
    const committed: CommittedBlob[] = [];
    try {
      await readPortableZip(
        packageBytes,
        async (entry) => {
          const chunks: Buffer[] = [];
          for await (const chunk of entry.bytes) chunks.push(Buffer.from(chunk));
          try {
            manifest = parseManifestV1(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            if (error instanceof InvalidPortablePackageError) throw error;
            throw new InvalidPortablePackageError('invalid_manifest_json');
          }
          return new Map(manifest.assets.map((asset) => [asset.path, asset.byteSize]));
        },
        async (entry) => {
          const asset = manifest?.assets.find((candidate) => candidate.path === entry.path);
          if (!asset) throw new InvalidPortablePackageError('unexpected_zip_entry');
          const blob = await this.blobs.stage(entry.bytes);
          const digest = await entry.sha256;
          if (
            blob.size !== asset.byteSize ||
            blob.checksum !== asset.sha256 ||
            digest !== asset.sha256
          ) {
            await this.blobs.discard(blob);
            throw new InvalidPortablePackageError('asset_checksum_mismatch');
          }
          staged.set(asset.id, blob);
        },
        this.#limits,
      );
      if (!manifest) throw new InvalidPortablePackageError('missing_manifest');
      for (const asset of manifest.assets) {
        const blob = staged.get(asset.id);
        if (!blob) throw new InvalidPortablePackageError('missing_asset');
        committed.push(await this.blobs.commit(blob));
      }
      const modelId = await this.#publish(ownerId, manifest, committed, options.modelId);
      return { modelId };
    } catch (error) {
      await Promise.allSettled([...staged.values()].map((blob) => this.blobs.discard(blob)));
      await Promise.allSettled(committed.map((blob) => this.blobs.delete(blob.key)));
      if (
        error instanceof InvalidPortablePackageError ||
        error instanceof CataloguePortabilityError
      )
        throw error;
      throw new CataloguePortabilityError('The export package could not be imported');
    }
  }

  async #publish(
    ownerId: string,
    manifest: YukiExportManifestV1,
    blobs: readonly CommittedBlob[],
    requestedModelId?: string,
  ): Promise<string> {
    const modelId = requestedModelId ?? this.#newId();
    const versionIds = new Map(manifest.versions.map((version) => [version.id, this.#newId()]));
    const assetIds = new Map(manifest.assets.map((asset) => [asset.id, this.#newId()]));
    const objectIds = new Map(manifest.assets.map((asset) => [asset.id, this.#newId()]));
    const now = this.#now();
    await this.database.transaction().execute(async (transaction) => {
      for (const [index, asset] of manifest.assets.entries()) {
        const blob = blobs[index];
        if (!blob) throw new Error('Committed asset mapping is incomplete');
        await transaction
          .insertInto('stored_objects')
          .values({
            id: objectIds.get(asset.id) as string,
            backend: this.options.storageBackend,
            object_key: blob.key,
            checksum: blob.checksum,
            byte_size: blob.size,
            state: 'committed',
            reference_count: 0,
            delete_after: null,
            deletion_error: null,
            created_at: now,
            updated_at: now,
          })
          .executeTakeFirstOrThrow();
      }
      await transaction
        .insertInto('catalogue_models')
        .values({
          id: modelId,
          owner_id: ownerId,
          name: manifest.model.name,
          description: manifest.model.description,
          import_source: 'yuki_export',
          source_url: manifest.model.sourceUrl,
          creator: manifest.model.creator,
          license: manifest.model.license,
          favorite: manifest.model.favorite,
          current_version_id: versionIds.get(manifest.model.currentVersionId) as string,
          cover_asset_id:
            manifest.model.coverAssetId === null
              ? null
              : (assetIds.get(manifest.model.coverAssetId) as string),
          print_count: 0,
          last_printed_at: null,
          created_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      for (const version of manifest.versions)
        await transaction
          .insertInto('catalogue_model_versions')
          .values({
            id: versionIds.get(version.id) as string,
            model_id: modelId,
            label: version.label,
            change_note: version.changeNote,
            metadata_schema_version: version.metadataSchemaVersion,
            metadata_snapshot: version.metadata,
            created_at: new Date(version.createdAt),
            published_at: null,
          })
          .executeTakeFirstOrThrow();
      for (const asset of manifest.assets) {
        const id = assetIds.get(asset.id) as string;
        const objectId = objectIds.get(asset.id) as string;
        await transaction
          .insertInto('catalogue_assets')
          .values({
            id,
            model_id: modelId,
            model_version_id: versionIds.get(asset.versionId) as string,
            stored_object_id: objectId,
            role: asset.role,
            format: asset.format,
            original_filename: asset.originalFilename,
            detected_mime_type: asset.detectedMimeType,
            byte_size: asset.byteSize,
            checksum: asset.sha256,
            imported_at: new Date(asset.importedAt),
            published_at: null,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('stored_object_references')
          .values({
            stored_object_id: objectId,
            owner_type: 'catalogue_asset',
            owner_id: id,
            created_at: now,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable('stored_objects')
          .set({ reference_count: 1, updated_at: now })
          .where('id', '=', objectId)
          .executeTakeFirstOrThrow();
      }
      for (const version of manifest.versions) {
        const versionId = versionIds.get(version.id) as string;
        await transaction
          .updateTable('catalogue_assets')
          .set({ published_at: now })
          .where('model_version_id', '=', versionId)
          .execute();
        await transaction
          .updateTable('catalogue_model_versions')
          .set({ published_at: now })
          .where('id', '=', versionId)
          .executeTakeFirstOrThrow();
      }
      for (const name of manifest.tags) {
        const tag = await transaction
          .insertInto('catalogue_tags')
          .values({
            id: this.#newId(),
            owner_id: ownerId,
            name,
            normalized_name: name.trim().toLowerCase(),
            created_at: now,
          })
          .onConflict((conflict) =>
            conflict.columns(['owner_id', 'normalized_name']).doUpdateSet({ name }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('catalogue_model_tags')
          .values({ model_id: modelId, tag_id: tag.id, owner_id: ownerId, created_at: now })
          .executeTakeFirstOrThrow();
      }
      for (const item of manifest.collections) {
        const collection = await transaction
          .insertInto('catalogue_collections')
          .values({
            id: this.#newId(),
            owner_id: ownerId,
            name: item.name,
            normalized_name: item.name.trim().toLowerCase(),
            description: item.description,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict
              .columns(['owner_id', 'normalized_name'])
              .doUpdateSet({ name: item.name, description: item.description, updated_at: now }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('catalogue_model_collections')
          .values({
            model_id: modelId,
            collection_id: collection.id,
            owner_id: ownerId,
            created_at: now,
          })
          .executeTakeFirstOrThrow();
      }
    });
    return modelId;
  }
}

export class CataloguePortabilityError extends Error {
  override readonly name: string = 'CataloguePortabilityError';
}
export class CataloguePortabilityNotFoundError extends CataloguePortabilityError {
  override readonly name: string = 'CataloguePortabilityNotFoundError';
}
export class CataloguePortabilityIntegrityError extends CataloguePortabilityError {
  override readonly name: string = 'CataloguePortabilityIntegrityError';
}

async function* one(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}
function byteSize(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new CataloguePortabilityIntegrityError('Invalid asset size');
  return result;
}
