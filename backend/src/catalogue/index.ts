export {
  type CatalogueFeature,
  type CatalogueFeatureOptions,
  type CatalogueIdentityBoundary,
  registerCatalogueFeature,
} from './feature.js';
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
export * from './search/index.js';
export {
  type CatalogueAssetInput,
  CatalogueConflictError,
  type CatalogueDeletionPolicy,
  CatalogueNotFoundError,
  CatalogueService,
  type CatalogueServiceOptions,
  type CatalogueVersionInput,
  type CollectionRecord,
  type CreateModelInput,
  createCatalogueDeletionPolicy,
  type DeletedAssetReference,
  type ModelDetail,
  type UpdateModelInput,
} from './service.js';
