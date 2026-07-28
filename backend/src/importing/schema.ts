import type { ColumnType } from 'kysely';

import type { CatalogueDatabaseSchema } from '../catalogue/index.js';
import type { JobDatabaseSchema } from '../platform/jobs/index.js';

export type ImportSessionState = 'receiving' | 'queued' | 'processing' | 'succeeded' | 'failed';

export interface ImportSessionTable {
  readonly id: string;
  readonly owner_id: string;
  readonly state: ImportSessionState;
  readonly original_filename: string;
  readonly claimed_mime_type: string;
  readonly model_name: string;
  readonly purpose: ColumnType<
    'new_model' | 'new_version',
    'new_model' | 'new_version' | undefined,
    never
  >;
  readonly target_model_id: string | null;
  readonly version_label: string | null;
  readonly change_note: string | null;
  readonly idempotency_key: string | null;
  readonly uploaded_bytes: ColumnType<string | number, number, number>;
  readonly checksum: string | null;
  readonly stored_object_id: string | null;
  readonly job_id: string | null;
  readonly model_id: string | null;
  readonly progress: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly processing_completed: ColumnType<boolean, boolean | undefined, boolean>;
  readonly processing_report: unknown | null;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
  readonly completed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface ImportFileTable {
  readonly id: string;
  readonly session_id: string;
  readonly file_key: string;
  readonly original_filename: string;
  readonly is_original: boolean;
  readonly stored_object_id: string | null;
  readonly status: 'accepted' | 'failed';
  readonly role: 'geometry' | 'gcode' | 'image' | 'document' | 'other' | 'original_archive' | null;
  readonly format:
    | 'stl'
    | '3mf'
    | 'obj'
    | 'step'
    | 'gcode'
    | 'image'
    | 'document'
    | 'archive'
    | 'other'
    | null;
  readonly detected_mime_type: string | null;
  readonly byte_size: ColumnType<string | number, number, number>;
  readonly checksum: string;
  readonly detection: unknown | null;
  readonly warnings: unknown;
  readonly duplicate_asset_ids: readonly string[];
  readonly duplicate_decision: 'not_required' | 'required' | 'keep';
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly error_retryable: boolean | null;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface ImportSchema {
  readonly import_sessions: ImportSessionTable;
  readonly import_files: ImportFileTable;
}

export type ImportDatabaseSchema = ImportSchema & CatalogueDatabaseSchema & JobDatabaseSchema;
