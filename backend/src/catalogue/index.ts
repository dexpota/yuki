export {
  insertDraftAsset,
  insertDraftVersion,
  insertModel,
  type NewCatalogueAsset,
  type NewCatalogueModel,
  type NewCatalogueModelVersion,
  normalizeCatalogueName,
  publishVersion,
} from './persistence.js';
export type {
  CatalogueAssetFormat,
  CatalogueAssetRole,
  CatalogueAssetTable,
  CatalogueCollectionTable,
  CatalogueDatabaseSchema,
  CatalogueImportSource,
  CatalogueModelCollectionTable,
  CatalogueModelTable,
  CatalogueModelTagTable,
  CatalogueModelVersionTable,
  CatalogueSchema,
  CatalogueTagTable,
} from './schema.js';
