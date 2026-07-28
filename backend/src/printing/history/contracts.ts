import type { ColumnType, Generated } from 'kysely';
import type { StorageSchema } from '../../platform/storage/index.js';
import type { PrinterMonitoringDatabaseSchema } from '../monitoring/index.js';
import type { PrintStartDatabaseSchema } from '../start/index.js';

export type PrintOutcome = 'successful' | 'failed' | 'cancelled' | 'unknown';
export type PrintAttemptSource = 'remote' | 'manual' | 'external';

export interface PrintAttemptEventTable {
  readonly id: Generated<string>;
  readonly owner_id: string;
  readonly print_attempt_id: string;
  readonly kind:
    | 'created'
    | 'printing'
    | 'paused'
    | 'resumed'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'reconciliation_required'
    | 'observation';
  readonly facts: unknown;
  readonly recorded_at: ColumnType<Date, Date | string, never>;
}

export interface PrintAttemptOutcomeCorrectionTable {
  readonly id: string;
  readonly owner_id: string;
  readonly print_attempt_id: string;
  readonly previous_outcome: PrintOutcome | null;
  readonly outcome: PrintOutcome;
  readonly reason: string;
  readonly idempotency_key: string | null;
  readonly corrected_at: ColumnType<Date, Date | string, never>;
}

export interface PrintAttemptNoteRevisionTable {
  readonly id: string;
  readonly owner_id: string;
  readonly print_attempt_id: string;
  readonly notes: string;
  readonly idempotency_key: string | null;
  readonly created_at: ColumnType<Date, Date | string, never>;
}

export interface PrintAttemptPhotoTable {
  readonly id: string;
  readonly owner_id: string;
  readonly print_attempt_id: string;
  readonly stored_object_id: string;
  readonly original_filename: string;
  readonly detected_mime_type: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly byte_size: ColumnType<string | number, number, never>;
  readonly checksum: string;
  readonly idempotency_key: string | null;
  readonly created_at: ColumnType<Date, Date | string, never>;
}

export type PrintHistoryDatabaseSchema = PrintStartDatabaseSchema &
  PrinterMonitoringDatabaseSchema &
  StorageSchema & {
    readonly print_attempt_events: PrintAttemptEventTable;
    readonly print_attempt_outcome_corrections: PrintAttemptOutcomeCorrectionTable;
    readonly print_attempt_note_revisions: PrintAttemptNoteRevisionTable;
    readonly print_attempt_photos: PrintAttemptPhotoTable;
  };

export interface PrintPhotoView {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly checksum: string;
  readonly createdAt: Date;
}

export interface PrintAttemptView {
  readonly id: string;
  readonly source: PrintAttemptSource;
  readonly queueEntryId: string | null;
  readonly printerId: string | null;
  readonly modelId: string | null;
  readonly modelVersionId: string | null;
  readonly assetId: string | null;
  readonly state: string;
  readonly outcome: PrintOutcome | null;
  readonly notes: string;
  readonly statistics: unknown;
  readonly printerSnapshot: unknown;
  readonly modelSnapshot: unknown;
  readonly assetSnapshot: unknown;
  readonly compatibilitySnapshot: unknown;
  readonly overrideJustification: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
  readonly photos: readonly PrintPhotoView[];
}
