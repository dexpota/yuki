import type { Insertable, Transaction } from 'kysely';

import type {
  CatalogueAssetTable,
  CatalogueDatabaseSchema,
  CatalogueModelTable,
  CatalogueModelVersionTable,
} from './schema.js';

export type NewCatalogueModel = Insertable<CatalogueModelTable>;
export type NewCatalogueModelVersion = Insertable<CatalogueModelVersionTable>;
export type NewCatalogueAsset = Insertable<CatalogueAssetTable>;

/**
 * Low-level catalogue writes shared by import and catalogue workflows. Business
 * authorization and CRUD policy deliberately remain in those owning workflows.
 */
export async function insertModel<Schema extends CatalogueDatabaseSchema>(
  transaction: Transaction<Schema>,
  model: NewCatalogueModel,
): Promise<void> {
  const catalogue = transaction as unknown as Transaction<CatalogueDatabaseSchema>;
  await catalogue.insertInto('catalogue_models').values(model).executeTakeFirstOrThrow();
}

export async function insertDraftVersion<Schema extends CatalogueDatabaseSchema>(
  transaction: Transaction<Schema>,
  version: NewCatalogueModelVersion,
): Promise<void> {
  if (version.published_at != null)
    throw new Error('A new catalogue version must start as a draft');
  const catalogue = transaction as unknown as Transaction<CatalogueDatabaseSchema>;
  await catalogue.insertInto('catalogue_model_versions').values(version).executeTakeFirstOrThrow();
}

/** Adds the authoritative stored-object reference atomically with the logical asset. */
export async function insertDraftAsset<Schema extends CatalogueDatabaseSchema>(
  transaction: Transaction<Schema>,
  asset: NewCatalogueAsset,
): Promise<void> {
  if (asset.published_at != null) throw new Error('A new catalogue asset must start as a draft');
  const catalogue = transaction as unknown as Transaction<CatalogueDatabaseSchema>;

  const object = await catalogue
    .selectFrom('stored_objects')
    .select(['id', 'state', 'checksum', 'byte_size'])
    .where('id', '=', asset.stored_object_id)
    .forUpdate()
    .executeTakeFirst();
  if (!object) throw new Error('Stored object does not exist');
  if (object.state !== 'committed') throw new Error('Stored object is not committed');
  if (object.checksum !== asset.checksum || Number(object.byte_size) !== asset.byte_size)
    throw new Error('Asset metadata does not match its stored object');

  await catalogue.insertInto('catalogue_assets').values(asset).executeTakeFirstOrThrow();
  await catalogue
    .insertInto('stored_object_references')
    .values({
      stored_object_id: asset.stored_object_id,
      owner_type: 'catalogue_asset',
      owner_id: asset.id,
      created_at: new Date(),
    })
    .executeTakeFirstOrThrow();
  await catalogue
    .updateTable('stored_objects')
    .set((expression) => ({
      reference_count: expression('reference_count', '+', 1),
      updated_at: new Date(),
    }))
    .where('id', '=', asset.stored_object_id)
    .executeTakeFirstOrThrow();
}

/** Publishes every draft asset first, then seals the version against future writes. */
export async function publishVersion<Schema extends CatalogueDatabaseSchema>(
  transaction: Transaction<Schema>,
  versionId: string,
  publishedAt: Date,
): Promise<void> {
  const catalogue = transaction as unknown as Transaction<CatalogueDatabaseSchema>;
  await catalogue
    .updateTable('catalogue_assets')
    .set({ published_at: publishedAt })
    .where('model_version_id', '=', versionId)
    .where('published_at', 'is', null)
    .execute();
  await catalogue
    .updateTable('catalogue_model_versions')
    .set({ published_at: publishedAt })
    .where('id', '=', versionId)
    .where('published_at', 'is', null)
    .returning('id')
    .executeTakeFirstOrThrow();
}

export function normalizeCatalogueName(name: string): string {
  return name.trim().toLowerCase();
}
