import type { ColumnType } from 'kysely';

import type { CatalogueDatabaseSchema } from '../../catalogue/index.js';
import type { GcodeFactsSnapshotV1 } from '../gcode/index.js';
import type { PrinterDatabaseSchema, PrinterProfileV1 } from '../printers/public.js';

export const compatibilityRuleSetVersion = '1.0.0' as const;
export const compatibilitySnapshotSchemaVersion = 1 as const;

export type CompatibilityStatus = 'compatible' | 'warning' | 'unknown' | 'incompatible';
export type CompatibilityCheckStatus =
  | 'pass'
  | 'warning'
  | 'unknown'
  | 'incompatible'
  | 'not_applicable';

export interface PrinterCompatibilitySnapshotV1 {
  readonly schemaVersion: 1;
  readonly printerId: string;
  readonly displayName: string;
  readonly capturedAt: string;
  readonly profile: PrinterProfileV1;
}

export interface CompatibilityCheck {
  readonly rule:
    | 'build_volume'
    | 'target_printer'
    | 'gcode_flavor'
    | 'nozzle_diameter'
    | 'extruder_count';
  readonly status: CompatibilityCheckStatus;
  readonly code: string;
  readonly message: string;
}

export interface CompatibilityResult {
  readonly status: CompatibilityStatus;
  readonly blocksByDefault: boolean;
  readonly canOverride: boolean;
  readonly checks: readonly CompatibilityCheck[];
}

export interface CompatibilityEvaluationSnapshotV1 {
  readonly schemaVersion: 1;
  readonly ruleSetVersion: typeof compatibilityRuleSetVersion;
  readonly evaluatedAt: string;
  readonly gcode: GcodeFactsSnapshotV1;
  readonly printer: PrinterCompatibilitySnapshotV1;
  readonly result: CompatibilityResult;
}

export interface CompatibilityEvaluationTable {
  readonly id: string;
  readonly owner_id: string;
  readonly asset_id: string;
  readonly printer_id: string;
  readonly rule_set_version: string;
  readonly status: CompatibilityStatus;
  readonly gcode_snapshot: unknown;
  readonly printer_snapshot: unknown;
  readonly result_snapshot: unknown;
  readonly created_at: ColumnType<Date, Date | string, never>;
}

export type CompatibilityDatabaseSchema = CatalogueDatabaseSchema &
  PrinterDatabaseSchema & {
    readonly printing_compatibility_evaluations: CompatibilityEvaluationTable;
  };
