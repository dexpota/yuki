import type { ColumnType } from 'kysely';
import type { JobDatabaseSchema } from '../../platform/jobs/index.js';
import type { CatalogueDatabaseSchema } from '../schema.js';

export type GeneratedArtifactKind = 'geometry_preview' | 'thumbnail' | 'toolpath_preview';
export type GeneratedArtifactStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'unsupported';

export interface GeneratedArtifactTable {
  readonly id: string;
  readonly owner_id: string;
  readonly source_asset_id: string;
  readonly kind: GeneratedArtifactKind;
  readonly status: GeneratedArtifactStatus;
  readonly generator: string;
  readonly generator_version: string;
  readonly stored_object_id: string | null;
  readonly mime_type: string | null;
  readonly byte_size: ColumnType<string | number | null, number | null, number | null>;
  readonly dimensions: unknown | null;
  readonly summary: unknown | null;
  readonly failure_code: string | null;
  readonly failure_message: string | null;
  readonly attempt: number;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
  readonly completed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export type PreviewDatabaseSchema = CatalogueDatabaseSchema &
  JobDatabaseSchema & {
    readonly catalogue_generated_artifacts: GeneratedArtifactTable;
  };

export interface ArtifactIdentity {
  readonly sourceAssetId: string;
  readonly kind: GeneratedArtifactKind;
  readonly generator: string;
  readonly generatorVersion: string;
}

export interface ArtifactView extends ArtifactIdentity {
  readonly id: string;
  readonly status: GeneratedArtifactStatus;
  readonly storedObjectId: string | null;
  readonly mimeType: string | null;
  readonly byteSize: number | null;
  readonly dimensions: unknown | null;
  readonly summary: unknown | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly attempt: number;
}

export interface ReadyArtifact {
  readonly storedObjectId: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly dimensions?: Readonly<Record<string, number | string>>;
  readonly summary?: Readonly<Record<string, number | string>>;
}

export interface ReadyArtifactBatchItem extends ReadyArtifact {
  readonly artifactId: string;
  readonly backend: string;
  readonly objectKey: string;
  readonly checksum: string;
}

export interface GeneratedPreviewFile {
  readonly kind: GeneratedArtifactKind;
  readonly mimeType: string;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly dimensions?: Readonly<Record<string, number | string>>;
  readonly summary?: Readonly<Record<string, number | string>>;
}

export type PreviewGenerationResult =
  | {
      readonly status: 'ready';
      readonly files: readonly GeneratedPreviewFile[];
      readonly cleanup?: () => Promise<void>;
    }
  | {
      readonly status: 'failed' | 'unsupported';
      readonly code: string;
      readonly message: string;
      readonly cleanup?: () => Promise<void>;
    };
