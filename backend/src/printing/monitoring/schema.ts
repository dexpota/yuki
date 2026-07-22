import type { ColumnType, Generated } from 'kysely';

import type { JobDatabaseSchema } from '../../platform/jobs/index.js';
import type { PrinterDatabaseSchema } from '../printers/public.js';
import type { MonitoredPrinterState, MonitoringGatewayFailureKind } from './gateway.js';

export type ObservationJobKind = 'none' | 'local' | 'external' | 'ambiguous';
export type PollReason = 'scheduled' | 'startup' | 'manual' | 'reconnect';
export type ReconciliationState =
  | 'idle'
  | 'local_job_detected'
  | 'external_job_detected'
  | 'ambiguous_active_job'
  | 'offline';

export interface PrinterObservationTable {
  readonly id: Generated<string>;
  readonly owner_id: string;
  readonly printer_id: string;
  readonly observed_at: ColumnType<Date, Date | string, never>;
  readonly poll_reason: PollReason;
  readonly online: boolean;
  readonly operational_state: MonitoredPrinterState | null;
  readonly active_job_kind: ObservationJobKind;
  readonly application_job_id: string | null;
  readonly upstream_file_name: string | null;
  readonly upstream_file_path: string | null;
  readonly upstream_file_origin: string | null;
  readonly progress_percent: number | null;
  readonly elapsed_seconds: number | null;
  readonly remaining_seconds: number | null;
  readonly temperatures: unknown;
  readonly failure_kind: MonitoringGatewayFailureKind | 'destination_rejected' | null;
}

export interface PrinterMonitoringStateTable {
  readonly printer_id: string;
  readonly owner_id: string;
  readonly last_attempt_at: ColumnType<Date, Date | string, Date | string>;
  readonly last_success_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  readonly last_failure_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  readonly consecutive_failures: number;
  readonly last_failure_kind: MonitoringGatewayFailureKind | 'destination_rejected' | null;
  readonly reconciliation_state: ReconciliationState;
  readonly updated_at: ColumnType<Date, Date | string, Date | string>;
}

export type PrinterMonitoringDatabaseSchema = PrinterDatabaseSchema &
  JobDatabaseSchema & {
    readonly printer_observations: PrinterObservationTable;
    readonly printer_monitoring_state: PrinterMonitoringStateTable;
  };
