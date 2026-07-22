import { randomUUID } from 'node:crypto';

import type { Kysely, Selectable, Transaction } from 'kysely';

import {
  insertDraftAsset,
  insertDraftVersion,
  insertModel,
  publishVersion,
} from './persistence.js';
import type {
  CatalogueAssetFormat,
  CatalogueAssetRole,
  CatalogueAssetTable,
  CatalogueDatabaseSchema,
  CatalogueImportSource,
  CatalogueModelTable,
  CatalogueModelVersionTable,
} from './schema.js';

export class CatalogueNotFoundError extends Error {
  override readonly name = 'CatalogueNotFoundError';
}

export class CatalogueConflictError extends Error {
  override readonly name = 'CatalogueConflictError';
}

export interface CatalogueAssetInput {
  readonly id?: string;
  readonly storedObjectId: string;
  readonly role: CatalogueAssetRole;
  readonly format: CatalogueAssetFormat;
  readonly originalFilename: string;
  readonly detectedMimeType: string;
  readonly byteSize: number;
  readonly checksum: string;
}

export interface CatalogueVersionInput {
  readonly id?: string;
  readonly label: string;
  readonly changeNote?: string | null;
  readonly metadataSnapshot: Readonly<Record<string, unknown>>;
  readonly assets: readonly CatalogueAssetInput[];
}

export interface CreateModelInput {
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly importSource: CatalogueImportSource;
  readonly sourceUrl?: string | null;
  readonly creator?: string | null;
  readonly license?: string | null;
  readonly favorite?: boolean;
  readonly initialVersion: CatalogueVersionInput;
}

export interface UpdateModelInput {
  readonly name?: string;
  readonly description?: string;
  readonly sourceUrl?: string | null;
  readonly creator?: string | null;
  readonly license?: string | null;
  readonly favorite?: boolean;
  /** Optional optimistic guard. The update conflicts when the representation changed. */
  readonly expectedUpdatedAt?: Date;
}

export interface DeletedAssetReference {
  readonly assetId: string;
  readonly storedObjectId: string;
}

export interface CatalogueDeletionPolicy {
  readonly deleteAfter: (deletedAt: Date) => Date;
}

export interface CatalogueServiceOptions {
  readonly deletionPolicy?: CatalogueDeletionPolicy;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export class CatalogueService {
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #deletionPolicy: CatalogueDeletionPolicy;

  public constructor(
    private readonly database: Kysely<CatalogueDatabaseSchema>,
    options: CatalogueServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
    this.#deletionPolicy =
      options.deletionPolicy ?? createCatalogueDeletionPolicy(7 * 24 * 60 * 60 * 1000);
  }

  public async createModel(ownerId: string, input: CreateModelInput): Promise<ModelDetail> {
    validateModelInput(input);
    const modelId = input.id ?? this.#newId();
    const versionId = input.initialVersion.id ?? this.#newId();
    const now = this.#now();
    try {
      await this.database.transaction().execute(async (transaction) => {
        await insertModel(transaction, {
          id: modelId,
          owner_id: ownerId,
          name: input.name.trim(),
          description: input.description ?? '',
          import_source: input.importSource,
          source_url: input.sourceUrl ?? null,
          creator: input.creator ?? null,
          license: input.license ?? null,
          favorite: input.favorite ?? false,
          current_version_id: versionId,
          cover_asset_id: null,
          print_count: 0,
          last_printed_at: null,
          created_at: now,
          updated_at: now,
        });
        await createPublishedVersion(
          transaction,
          modelId,
          versionId,
          input.initialVersion,
          now,
          this.#newId,
        );
      });
    } catch (error) {
      throw translateConflict(error);
    }
    return this.getModel(ownerId, modelId);
  }

  public async getModel(ownerId: string, modelId: string): Promise<ModelDetail> {
    const model = await this.database
      .selectFrom('catalogue_models')
      .selectAll()
      .where('id', '=', modelId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!model) throw new CatalogueNotFoundError('Model not found');

    const [versions, assets, tags, collections] = await Promise.all([
      this.database
        .selectFrom('catalogue_model_versions as version')
        .innerJoin('catalogue_models as model', 'model.id', 'version.model_id')
        .selectAll('version')
        .where('version.model_id', '=', modelId)
        .where('model.owner_id', '=', ownerId)
        .where('version.published_at', 'is not', null)
        .orderBy('version.created_at', 'desc')
        .execute(),
      this.database
        .selectFrom('catalogue_assets as asset')
        .innerJoin('catalogue_models as model', 'model.id', 'asset.model_id')
        .selectAll('asset')
        .where('asset.model_id', '=', modelId)
        .where('model.owner_id', '=', ownerId)
        .where('asset.published_at', 'is not', null)
        .orderBy('asset.imported_at', 'asc')
        .execute(),
      this.database
        .selectFrom('catalogue_model_tags as relation')
        .innerJoin('catalogue_models as model', 'model.id', 'relation.model_id')
        .innerJoin('catalogue_tags as tag', 'tag.id', 'relation.tag_id')
        .select(['tag.id', 'tag.name'])
        .where('relation.model_id', '=', modelId)
        .where('model.owner_id', '=', ownerId)
        .where('tag.owner_id', '=', ownerId)
        .orderBy('tag.normalized_name', 'asc')
        .execute(),
      this.database
        .selectFrom('catalogue_model_collections as relation')
        .innerJoin('catalogue_models as model', 'model.id', 'relation.model_id')
        .innerJoin('catalogue_collections as collection', 'collection.id', 'relation.collection_id')
        .select(['collection.id', 'collection.name', 'collection.description'])
        .where('relation.model_id', '=', modelId)
        .where('model.owner_id', '=', ownerId)
        .where('collection.owner_id', '=', ownerId)
        .orderBy('collection.normalized_name', 'asc')
        .execute(),
    ]);
    return { model, versions, assets, tags, collections };
  }

  public async updateModel(
    ownerId: string,
    modelId: string,
    input: UpdateModelInput,
  ): Promise<ModelDetail> {
    validateModelUpdate(input);
    const values = compact({
      name: input.name?.trim(),
      description: input.description,
      source_url: input.sourceUrl,
      creator: input.creator,
      license: input.license,
      favorite: input.favorite,
      updated_at: this.#now(),
    });
    let query = this.database
      .updateTable('catalogue_models')
      .set(values)
      .where('id', '=', modelId)
      .where('owner_id', '=', ownerId);
    if (input.expectedUpdatedAt !== undefined)
      query = query.where('updated_at', '=', input.expectedUpdatedAt);
    const updated = await query.returning('id').executeTakeFirst();
    if (!updated) {
      const exists = await this.ownedModelExists(ownerId, modelId);
      if (exists && input.expectedUpdatedAt !== undefined)
        throw new CatalogueConflictError('Model was changed by another request');
      throw new CatalogueNotFoundError('Model not found');
    }
    return this.getModel(ownerId, modelId);
  }

  public async addVersion(
    ownerId: string,
    modelId: string,
    input: CatalogueVersionInput,
  ): Promise<ModelDetail> {
    validateVersionInput(input);
    const versionId = input.id ?? this.#newId();
    const now = this.#now();
    try {
      await this.database.transaction().execute(async (transaction) => {
        const owned = await lockOwnedModel(transaction, ownerId, modelId);
        if (!owned) throw new CatalogueNotFoundError('Model not found');
        await createPublishedVersion(transaction, modelId, versionId, input, now, this.#newId);
        await transaction
          .updateTable('catalogue_models')
          .set({ current_version_id: versionId, updated_at: now })
          .where('id', '=', modelId)
          .where('owner_id', '=', ownerId)
          .executeTakeFirstOrThrow();
      });
    } catch (error) {
      throw translateConflict(error);
    }
    return this.getModel(ownerId, modelId);
  }

  public async restoreVersion(
    ownerId: string,
    modelId: string,
    versionId: string,
  ): Promise<ModelDetail> {
    const now = this.#now();
    const updated = await this.database
      .updateTable('catalogue_models')
      .set({ current_version_id: versionId, updated_at: now })
      .where('id', '=', modelId)
      .where('owner_id', '=', ownerId)
      .where((expression) =>
        expression.exists(
          expression
            .selectFrom('catalogue_model_versions')
            .select('id')
            .where('id', '=', versionId)
            .where('model_id', '=', modelId)
            .where('published_at', 'is not', null),
        ),
      )
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw new CatalogueNotFoundError('Model or published version not found');
    return this.getModel(ownerId, modelId);
  }

  public async replaceTags(
    ownerId: string,
    modelId: string,
    names: readonly string[],
  ): Promise<ModelDetail> {
    const unique = normalizedNames(names, 100);
    await this.database.transaction().execute(async (transaction) => {
      if (!(await lockOwnedModel(transaction, ownerId, modelId)))
        throw new CatalogueNotFoundError('Model not found');
      const now = this.#now();
      const tagIds: string[] = [];
      for (const tag of unique) {
        const row = await transaction
          .insertInto('catalogue_tags')
          .values({
            id: this.#newId(),
            owner_id: ownerId,
            name: tag.name,
            normalized_name: tag.normalized,
            created_at: now,
          })
          .onConflict((conflict) =>
            conflict.columns(['owner_id', 'normalized_name']).doUpdateSet({ name: tag.name }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();
        tagIds.push(row.id);
      }
      await transaction
        .deleteFrom('catalogue_model_tags')
        .where('model_id', '=', modelId)
        .where('owner_id', '=', ownerId)
        .execute();
      if (tagIds.length > 0)
        await transaction
          .insertInto('catalogue_model_tags')
          .values(
            tagIds.map((tagId) => ({
              model_id: modelId,
              tag_id: tagId,
              owner_id: ownerId,
              created_at: now,
            })),
          )
          .execute();
      await touchModel(transaction, ownerId, modelId, now);
    });
    return this.getModel(ownerId, modelId);
  }

  public async listTags(ownerId: string): Promise<readonly TagRecord[]> {
    return this.database
      .selectFrom('catalogue_tags')
      .select(['id', 'name'])
      .where('owner_id', '=', ownerId)
      .orderBy('normalized_name', 'asc')
      .execute();
  }

  public async listCollections(ownerId: string): Promise<readonly CollectionRecord[]> {
    return this.database
      .selectFrom('catalogue_collections')
      .select(['id', 'name', 'description', 'created_at', 'updated_at'])
      .where('owner_id', '=', ownerId)
      .orderBy('normalized_name', 'asc')
      .execute();
  }

  public async createCollection(
    ownerId: string,
    name: string,
    description = '',
  ): Promise<CollectionRecord> {
    const normalized = normalizeRequiredName(name, 200);
    try {
      return await this.database
        .insertInto('catalogue_collections')
        .values({
          id: this.#newId(),
          owner_id: ownerId,
          name: name.trim(),
          normalized_name: normalized,
          description,
          created_at: this.#now(),
          updated_at: this.#now(),
        })
        .returning(['id', 'name', 'description', 'created_at', 'updated_at'])
        .executeTakeFirstOrThrow();
    } catch (error) {
      throw translateConflict(error);
    }
  }

  public async updateCollection(
    ownerId: string,
    collectionId: string,
    input: { readonly name?: string; readonly description?: string },
  ): Promise<CollectionRecord> {
    const values = compact({
      name: input.name?.trim(),
      normalized_name:
        input.name === undefined ? undefined : normalizeRequiredName(input.name, 200),
      description: input.description,
      updated_at: this.#now(),
    });
    try {
      const result = await this.database
        .updateTable('catalogue_collections')
        .set(values)
        .where('id', '=', collectionId)
        .where('owner_id', '=', ownerId)
        .returning(['id', 'name', 'description', 'created_at', 'updated_at'])
        .executeTakeFirst();
      if (!result) throw new CatalogueNotFoundError('Collection not found');
      return result;
    } catch (error) {
      throw translateConflict(error);
    }
  }

  public async deleteCollection(ownerId: string, collectionId: string): Promise<void> {
    const deleted = await this.database
      .deleteFrom('catalogue_collections')
      .where('id', '=', collectionId)
      .where('owner_id', '=', ownerId)
      .returning('id')
      .executeTakeFirst();
    if (!deleted) throw new CatalogueNotFoundError('Collection not found');
  }

  public async replaceCollections(
    ownerId: string,
    modelId: string,
    collectionIds: readonly string[],
  ): Promise<ModelDetail> {
    const ids = [...new Set(collectionIds)];
    await this.database.transaction().execute(async (transaction) => {
      if (!(await lockOwnedModel(transaction, ownerId, modelId)))
        throw new CatalogueNotFoundError('Model not found');
      const owned =
        ids.length === 0
          ? []
          : await transaction
              .selectFrom('catalogue_collections')
              .select('id')
              .where('owner_id', '=', ownerId)
              .where('id', 'in', ids)
              .execute();
      if (owned.length !== ids.length) throw new CatalogueNotFoundError('Collection not found');
      await transaction
        .deleteFrom('catalogue_model_collections')
        .where('model_id', '=', modelId)
        .where('owner_id', '=', ownerId)
        .execute();
      const now = this.#now();
      if (ids.length > 0)
        await transaction
          .insertInto('catalogue_model_collections')
          .values(
            ids.map((collectionId) => ({
              model_id: modelId,
              collection_id: collectionId,
              owner_id: ownerId,
              created_at: now,
            })),
          )
          .execute();
      await touchModel(transaction, ownerId, modelId, now);
    });
    return this.getModel(ownerId, modelId);
  }

  public async deleteModel(ownerId: string, modelId: string): Promise<DeletedAssetReference[]> {
    const deletedAt = this.#now();
    return this.database.transaction().execute(async (transaction) => {
      if (!(await lockOwnedModel(transaction, ownerId, modelId)))
        throw new CatalogueNotFoundError('Model not found');
      const assets = await transaction
        .selectFrom('catalogue_assets as asset')
        .innerJoin('catalogue_models as model', 'model.id', 'asset.model_id')
        .select(['asset.id as assetId', 'asset.stored_object_id as storedObjectId'])
        .where('asset.model_id', '=', modelId)
        .where('model.owner_id', '=', ownerId)
        .execute();
      // Delete the aggregate first so the immutability triggers can distinguish aggregate deletion.
      await transaction
        .deleteFrom('catalogue_models')
        .where('id', '=', modelId)
        .where('owner_id', '=', ownerId)
        .executeTakeFirstOrThrow();
      const deleteAfter = this.#deletionPolicy.deleteAfter(deletedAt);
      for (const asset of assets)
        await releaseStoredObjectReference(transaction, asset, deleteAfter, deletedAt);
      return assets;
    });
  }

  private async ownedModelExists(ownerId: string, modelId: string): Promise<boolean> {
    return (
      (await this.database
        .selectFrom('catalogue_models')
        .select('id')
        .where('id', '=', modelId)
        .where('owner_id', '=', ownerId)
        .executeTakeFirst()) !== undefined
    );
  }
}

export function createCatalogueDeletionPolicy(retentionMs: number): CatalogueDeletionPolicy {
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0)
    throw new TypeError('Catalogue retention must be a non-negative integer');
  return { deleteAfter: (deletedAt) => new Date(deletedAt.getTime() + retentionMs) };
}

async function createPublishedVersion(
  transaction: Transaction<CatalogueDatabaseSchema>,
  modelId: string,
  versionId: string,
  input: CatalogueVersionInput,
  now: Date,
  newId: () => string,
): Promise<void> {
  validateVersionInput(input);
  await insertDraftVersion(transaction, {
    id: versionId,
    model_id: modelId,
    label: input.label.trim(),
    change_note: input.changeNote ?? null,
    metadata_schema_version: 1,
    metadata_snapshot: input.metadataSnapshot,
    created_at: now,
    published_at: null,
  });
  for (const asset of input.assets)
    await insertDraftAsset(transaction, {
      id: asset.id ?? newId(),
      model_id: modelId,
      model_version_id: versionId,
      stored_object_id: asset.storedObjectId,
      role: asset.role,
      format: asset.format,
      original_filename: asset.originalFilename.trim(),
      detected_mime_type: asset.detectedMimeType.trim(),
      byte_size: asset.byteSize,
      checksum: asset.checksum,
      imported_at: now,
      published_at: null,
    });
  await publishVersion(transaction, versionId, now);
}

async function lockOwnedModel(
  transaction: Transaction<CatalogueDatabaseSchema>,
  ownerId: string,
  modelId: string,
) {
  return transaction
    .selectFrom('catalogue_models')
    .select('id')
    .where('id', '=', modelId)
    .where('owner_id', '=', ownerId)
    .forUpdate()
    .executeTakeFirst();
}

async function touchModel(
  transaction: Transaction<CatalogueDatabaseSchema>,
  ownerId: string,
  modelId: string,
  now: Date,
): Promise<void> {
  await transaction
    .updateTable('catalogue_models')
    .set({ updated_at: now })
    .where('id', '=', modelId)
    .where('owner_id', '=', ownerId)
    .executeTakeFirstOrThrow();
}

async function releaseStoredObjectReference(
  transaction: Transaction<CatalogueDatabaseSchema>,
  asset: DeletedAssetReference,
  deleteAfter: Date,
  now: Date,
): Promise<void> {
  const object = await transaction
    .selectFrom('stored_objects')
    .select(['id', 'reference_count'])
    .where('id', '=', asset.storedObjectId)
    .forUpdate()
    .executeTakeFirst();
  if (!object) return;
  const removed = await transaction
    .deleteFrom('stored_object_references')
    .where('stored_object_id', '=', asset.storedObjectId)
    .where('owner_type', '=', 'catalogue_asset')
    .where('owner_id', '=', asset.assetId)
    .returning('stored_object_id')
    .executeTakeFirst();
  if (!removed) return;
  const referenceCount = object.reference_count - 1;
  if (referenceCount < 0) throw new Error('Stored object reference count is inconsistent');
  await transaction
    .updateTable('stored_objects')
    .set({
      reference_count: referenceCount,
      state: referenceCount === 0 ? 'pending_delete' : 'committed',
      delete_after: referenceCount === 0 ? deleteAfter : null,
      deletion_error: null,
      updated_at: now,
    })
    .where('id', '=', asset.storedObjectId)
    .executeTakeFirstOrThrow();
}

function validateModelInput(input: CreateModelInput): void {
  normalizeRequiredName(input.name, 300);
  validateVersionInput(input.initialVersion);
}

function validateModelUpdate(input: UpdateModelInput): void {
  if (input.name !== undefined) normalizeRequiredName(input.name, 300);
  if (Object.keys(input).length === 0) throw new TypeError('At least one model field is required');
}

function validateVersionInput(input: CatalogueVersionInput): void {
  normalizeRequiredName(input.label, 100);
  if (
    typeof input.metadataSnapshot !== 'object' ||
    input.metadataSnapshot === null ||
    Array.isArray(input.metadataSnapshot)
  )
    throw new TypeError('Metadata snapshot must be an object');
  if (input.assets.length === 0) throw new TypeError('A version must contain at least one asset');
  for (const asset of input.assets) {
    normalizeRequiredName(asset.originalFilename, 1024);
    normalizeRequiredName(asset.detectedMimeType, 255);
    if (!Number.isSafeInteger(asset.byteSize) || asset.byteSize < 0)
      throw new TypeError('Asset byte size is invalid');
    if (!/^[a-f0-9]{64}$/.test(asset.checksum)) throw new TypeError('Asset checksum is invalid');
  }
}

function normalizedNames(names: readonly string[], maximum: number) {
  const unique = new Map<string, string>();
  for (const name of names) {
    const normalized = normalizeRequiredName(name, maximum);
    if (!unique.has(normalized)) unique.set(normalized, name.trim());
  }
  return [...unique].map(([normalized, name]) => ({ normalized, name }));
}

function normalizeRequiredName(value: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > maximum)
    throw new TypeError(`Name must contain between 1 and ${maximum} characters`);
  return value.trim().toLowerCase();
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function translateConflict(error: unknown): unknown {
  if (error instanceof CatalogueNotFoundError || error instanceof TypeError) return error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return code === '23505' ? new CatalogueConflictError('Catalogue value already exists') : error;
}

export interface ModelDetail {
  readonly model: Selectable<CatalogueModelTable>;
  readonly versions: readonly Selectable<CatalogueModelVersionTable>[];
  readonly assets: readonly Selectable<CatalogueAssetTable>[];
  readonly tags: readonly { readonly id: string; readonly name: string }[];
  readonly collections: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  }[];
}
export interface CollectionRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}
export interface TagRecord {
  readonly id: string;
  readonly name: string;
}
