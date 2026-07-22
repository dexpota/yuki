import type { ColumnType } from 'kysely';

import type { JobDatabaseSchema } from '../../platform/jobs/index.js';
import type { CatalogueDatabaseSchema } from '../schema.js';

export interface CataloguePortabilityOperationTable {
  readonly id: string;
  readonly owner_id: string;
  readonly kind: 'export' | 'import';
  readonly state: 'queued' | 'running' | 'succeeded' | 'failed';
  readonly source_model_id: string | null;
  readonly imported_model_id: string | null;
  readonly input_stored_object_id: string | null;
  readonly output_stored_object_id: string | null;
  readonly job_id: string;
  readonly idempotency_key: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
  readonly completed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export type CataloguePortabilityDatabaseSchema = CatalogueDatabaseSchema &
  JobDatabaseSchema & {
    readonly catalogue_portability_operations: CataloguePortabilityOperationTable;
  };
