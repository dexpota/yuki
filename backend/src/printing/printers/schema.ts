import type { ColumnType } from 'kysely';

export type PrinterConnectionStatus = 'online' | 'offline' | 'unknown';

export interface PrinterTable {
  readonly id: string;
  readonly owner_id: string;
  readonly display_name: string;
  readonly octoprint_url: string;
  readonly encrypted_api_key: string;
  readonly enabled: boolean;
  readonly connection_status: PrinterConnectionStatus;
  readonly operational_state: string | null;
  readonly profile_schema_version: number;
  readonly profile: unknown;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
  readonly verified_at: ColumnType<Date, Date | string, Date | string>;
  readonly version: number;
}

export interface PrinterDatabaseSchema {
  readonly printers: PrinterTable;
}
