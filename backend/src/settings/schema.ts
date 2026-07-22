import type { ColumnType } from 'kysely';

export interface InstallationSettingsTable {
  readonly owner_id: string;
  readonly upload_max_bytes: ColumnType<string, string | number, string | number>;
  readonly archive_max_members: number;
  readonly archive_expanded_max_bytes: ColumnType<string, string | number, string | number>;
  readonly archive_max_ratio: number;
  readonly trash_retention_days: number;
  readonly job_retention_days: number;
  readonly observation_history_entries: number;
  readonly authentication_mode: 'password';
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
  readonly version: number;
}

export interface SettingsDatabaseSchema {
  readonly installation_settings: InstallationSettingsTable;
}
