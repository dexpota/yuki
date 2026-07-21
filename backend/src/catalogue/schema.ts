import type { ColumnType } from 'kysely';

import type { StorageSchema } from '../platform/storage/index.js';

type CreatedTimestamp = ColumnType<Date, Date | string, never>;
type BigIntValue = ColumnType<string | number, number, never>;

export type CatalogueImportSource = 'upload' | 'yuki_export';
export type CatalogueAssetRole =
  | 'geometry'
  | 'gcode'
  | 'image'
  | 'document'
  | 'other'
  | 'original_archive';
export type CatalogueAssetFormat =
  | 'stl'
  | '3mf'
  | 'obj'
  | 'step'
  | 'gcode'
  | 'image'
  | 'document'
  | 'archive'
  | 'other';

export interface CatalogueModelTable {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly description: string;
  readonly import_source: CatalogueImportSource;
  readonly source_url: string | null;
  readonly creator: string | null;
  readonly license: string | null;
  readonly favorite: boolean;
  readonly current_version_id: string;
  readonly cover_asset_id: string | null;
  readonly print_count: number;
  readonly last_printed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  readonly created_at: CreatedTimestamp;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface CatalogueModelVersionTable {
  readonly id: string;
  readonly model_id: string;
  readonly label: string;
  readonly change_note: string | null;
  readonly metadata_schema_version: number;
  readonly metadata_snapshot: unknown;
  readonly created_at: CreatedTimestamp;
  readonly published_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface CatalogueAssetTable {
  readonly id: string;
  readonly model_id: string;
  readonly model_version_id: string;
  readonly stored_object_id: string;
  readonly role: CatalogueAssetRole;
  readonly format: CatalogueAssetFormat;
  readonly original_filename: string;
  readonly detected_mime_type: string;
  readonly byte_size: BigIntValue;
  readonly checksum: string;
  readonly imported_at: CreatedTimestamp;
  readonly published_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface CatalogueTagTable {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly normalized_name: string;
  readonly created_at: CreatedTimestamp;
}

export interface CatalogueCollectionTable {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly normalized_name: string;
  readonly description: string;
  readonly created_at: CreatedTimestamp;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface CatalogueModelTagTable {
  readonly model_id: string;
  readonly tag_id: string;
  readonly owner_id: string;
  readonly created_at: CreatedTimestamp;
}

export interface CatalogueModelCollectionTable {
  readonly model_id: string;
  readonly collection_id: string;
  readonly owner_id: string;
  readonly created_at: CreatedTimestamp;
}

export interface CatalogueSchema {
  readonly catalogue_models: CatalogueModelTable;
  readonly catalogue_model_versions: CatalogueModelVersionTable;
  readonly catalogue_assets: CatalogueAssetTable;
  readonly catalogue_tags: CatalogueTagTable;
  readonly catalogue_collections: CatalogueCollectionTable;
  readonly catalogue_model_tags: CatalogueModelTagTable;
  readonly catalogue_model_collections: CatalogueModelCollectionTable;
}

/** Schema needed by catalogue persistence, composed with the platform-owned object tables. */
export type CatalogueDatabaseSchema = CatalogueSchema & StorageSchema;
