import type { ColumnType } from 'kysely';

import type { QueueDatabaseSchema } from '../queue/index.js';

export interface StartConfirmationTable {
  readonly id: string;
  readonly owner_id: string;
  readonly printer_id: string;
  readonly queue_entry_id: string | null;
  readonly token_hash: string;
  readonly challenge_snapshot: unknown;
  readonly issuance_idempotency_key: string | null;
  readonly consumption_idempotency_key: string | null;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly expires_at: ColumnType<Date, Date | string, never>;
  readonly consumed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export type PrintAttemptState =
  | 'starting'
  | 'printing'
  | 'paused'
  | 'reconciliation_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PrintAttemptTable {
  readonly id: string;
  readonly owner_id: string;
  readonly queue_entry_id: string | null;
  readonly printer_id: string | null;
  readonly model_id: string | null;
  readonly model_version_id: string | null;
  readonly asset_id: string | null;
  readonly state: PrintAttemptState;
  readonly outcome: 'successful' | 'failed' | 'cancelled' | 'unknown' | null;
  readonly printer_snapshot: unknown;
  readonly model_snapshot: unknown;
  readonly asset_snapshot: unknown;
  readonly compatibility_snapshot: unknown;
  readonly override_justification: string | null;
  readonly started_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  readonly completed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
  readonly source: ColumnType<
    'remote' | 'manual' | 'external',
    'remote' | 'manual' | 'external' | undefined,
    never
  >;
  readonly notes: ColumnType<string, string | undefined, string>;
  readonly statistics: ColumnType<unknown, unknown | undefined, unknown>;
  readonly creation_idempotency_key: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  readonly version: ColumnType<number, number | undefined, number>;
}

export type PrintStartDatabaseSchema = QueueDatabaseSchema & {
  readonly printing_start_confirmations: StartConfirmationTable;
  readonly print_attempts: PrintAttemptTable;
};

export interface StartChallenge {
  readonly token: string;
  readonly expiresAt: Date;
  readonly printer: { readonly id: string; readonly name: string };
  readonly file: { readonly assetId: string; readonly filename: string; readonly byteSize: number };
  readonly compatibilityStatus: string;
  readonly warnings: readonly string[];
  readonly safetyNotice: string;
}

export interface AcceptedPrintStart {
  readonly queueEntryId: string;
  readonly printAttemptId: string;
  readonly state: 'uploading';
}
