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
  readonly idempotency_key: string | null;
  readonly uploaded_bytes: ColumnType<string | number, number, number>;
  readonly checksum: string | null;
  readonly stored_object_id: string | null;
  readonly job_id: string | null;
  readonly model_id: string | null;
  readonly progress: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
  readonly completed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface ImportSchema {
  readonly import_sessions: ImportSessionTable;
}

export type ImportDatabaseSchema = ImportSchema & CatalogueDatabaseSchema & JobDatabaseSchema;
