import type { ColumnType } from 'kysely';

export interface FilamentPresetTable {
  readonly id: string;
  readonly owner_id: string;
  readonly display_name: string;
  readonly material: string;
  readonly color_name: string | null;
  readonly color_hex: string | null;
  readonly manufacturer: string | null;
  readonly product_name: string | null;
  readonly diameter_mm: ColumnType<string | number | null, number | null, number | null>;
  readonly notes: string;
  readonly archived_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
  readonly version: number;
}

export interface FilamentPresetDatabaseSchema {
  readonly filament_presets: FilamentPresetTable;
}
