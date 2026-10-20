import type { ColumnType } from 'kysely';

export interface PrintPlanEntryTable {
  readonly id: string;
  readonly owner_id: string;
  readonly model_id: string;
  readonly version_id: string;
  readonly model_name_snapshot: string;
  readonly version_label_snapshot: string;
  readonly position: number;
  readonly created_at: ColumnType<Date, Date | string, never>;
}

export interface PrintPlanningDatabaseSchema {
  readonly printing_plan_entries: PrintPlanEntryTable;
}

export interface PrintPlanEntryView {
  readonly id: string;
  readonly modelId: string;
  readonly versionId: string;
  readonly modelName: string;
  readonly versionLabel: string;
  readonly assets: readonly { readonly id: string; readonly filename: string }[];
  readonly unavailable: boolean;
  readonly position: number;
  readonly createdAt: Date;
}
