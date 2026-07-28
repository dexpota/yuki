import type { ColumnType } from 'kysely';

import type { JobDatabaseSchema } from '../../platform/jobs/index.js';
import type { PrintHistoryDatabaseSchema } from '../history/index.js';

export type NotificationKind =
  | 'print_completed'
  | 'print_failed'
  | 'print_cancelled'
  | 'printer_disconnected';

export interface NotificationTable {
  readonly id: string;
  readonly owner_id: string;
  readonly kind: NotificationKind;
  readonly print_attempt_id: string | null;
  readonly printer_id: string | null;
  readonly title: string;
  readonly message: string;
  readonly facts: unknown;
  readonly deduplication_key: string;
  readonly read_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
  readonly version: number;
}

export type NotificationDatabaseSchema = PrintHistoryDatabaseSchema &
  JobDatabaseSchema & {
    readonly notifications: NotificationTable;
  };

export interface NotificationView {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly printAttemptId: string | null;
  readonly printerId: string | null;
  readonly title: string;
  readonly message: string;
  readonly facts: unknown;
  readonly readAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}
