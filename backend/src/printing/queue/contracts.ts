import type { ColumnType } from 'kysely';
import type { JobDatabaseSchema } from '../../platform/jobs/index.js';
import type { CompatibilityDatabaseSchema, CompatibilityStatus } from '../compatibility/index.js';

export type QueueEntryState =
  | 'evaluating'
  | 'blocked'
  | 'queued'
  | 'uploading'
  | 'uploaded'
  | 'starting'
  | 'printing'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'reconciliation_required'
  | 'failed'
  | 'removed';

export interface QueueEntryTable {
  readonly id: string;
  readonly owner_id: string;
  readonly printer_id: string;
  readonly asset_id: string;
  readonly evaluation_job_id: string | null;
  readonly compatibility_evaluation_id: string | null;
  readonly state: QueueEntryState;
  readonly position: number | null;
  readonly compatibility_status: CompatibilityStatus | null;
  readonly compatibility_snapshot: unknown | null;
  readonly override_justification: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly idempotency_key: string | null;
  readonly start_command_job_id: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  readonly print_attempt_id: ColumnType<string | null, string | null | undefined, string | null>;
  readonly upstream_path: ColumnType<string | null, string | null | undefined, string | null>;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
  readonly version: number;
}

export type QueueDatabaseSchema = CompatibilityDatabaseSchema &
  JobDatabaseSchema & {
    readonly printing_queue_entries: QueueEntryTable;
  };

export interface QueueEntryView {
  readonly id: string;
  readonly printerId: string;
  readonly assetId: string;
  readonly state: QueueEntryState;
  readonly position: number | null;
  readonly compatibilityStatus: CompatibilityStatus | null;
  readonly compatibilitySnapshot: unknown | null;
  readonly overrideJustification: string | null;
  readonly printAttemptId: string | null;
  readonly upstreamPath: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}
