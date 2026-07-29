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

export interface NotificationWebhookConfigurationTable {
  readonly owner_id: string;
  readonly endpoint_origin: string;
  readonly encrypted_endpoint_url: string;
  readonly encrypted_bearer_token: string | null;
  readonly enabled: boolean;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
  readonly version: number;
}

export type NotificationDeliveryState =
  | 'pending'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'disabled';

export interface NotificationDeliveryTable {
  readonly id: string;
  readonly owner_id: string;
  readonly notification_id: string;
  readonly channel: 'webhook';
  readonly state: NotificationDeliveryState;
  readonly attempt_count: number;
  readonly response_status: number | null;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly last_attempt_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  readonly delivered_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
}

export type NotificationDatabaseSchema = PrintHistoryDatabaseSchema &
  JobDatabaseSchema & {
    readonly notifications: NotificationTable;
    readonly notification_webhook_configurations: NotificationWebhookConfigurationTable;
    readonly notification_deliveries: NotificationDeliveryTable;
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

export interface NotificationWebhookConfigurationView {
  readonly mode: 'webhook';
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly endpointDisplay: string | null;
  readonly bearerTokenConfigured: boolean;
  readonly version: number;
  readonly updatedAt: Date | null;
}

export interface NotificationDeliveryView {
  readonly id: string;
  readonly notificationId: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly state: NotificationDeliveryState;
  readonly attemptCount: number;
  readonly responseStatus: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly lastAttemptAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly updatedAt: Date;
}
