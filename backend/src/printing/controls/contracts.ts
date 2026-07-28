import type { ColumnType, Generated } from 'kysely';

import type { PrintHistoryDatabaseSchema } from '../history/index.js';

export type PrinterControlAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'set_tool_temperature'
  | 'set_bed_temperature'
  | 'home';

export type PrinterControlParameters =
  | Record<string, never>
  | { readonly tool: string; readonly targetCelsius: number }
  | { readonly targetCelsius: number }
  | { readonly axes: readonly ('x' | 'y' | 'z')[] };

export interface PrinterControlConfirmationTable {
  readonly id: string;
  readonly owner_id: string;
  readonly printer_id: string;
  readonly queue_entry_id: string | null;
  readonly action: PrinterControlAction;
  readonly parameters: unknown;
  readonly token_hash: string;
  readonly challenge_snapshot: unknown;
  readonly consumption_idempotency_key: string | null;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly expires_at: ColumnType<Date, Date | string, never>;
  readonly consumed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface PrinterControlCommandTable {
  readonly id: string;
  readonly owner_id: string;
  readonly printer_id: string;
  readonly queue_entry_id: string | null;
  readonly confirmation_id: string;
  readonly job_id: string;
  readonly action: PrinterControlAction;
  readonly parameters: unknown;
  readonly state: 'pending' | 'completed' | 'failed' | 'reconciliation_required';
  readonly result_code: string | null;
  readonly created_at: ColumnType<Date, Date | string, never>;
  readonly completed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface PrinterControlEventTable {
  readonly id: Generated<string>;
  readonly owner_id: string;
  readonly printer_id: string;
  readonly command_id: string;
  readonly queue_entry_id: string | null;
  readonly action: string;
  readonly outcome: 'accepted' | 'completed' | 'failed' | 'reconciliation_required';
  readonly facts: unknown;
  readonly recorded_at: ColumnType<Date, Date | string, never>;
}

export type PrinterControlDatabaseSchema = PrintHistoryDatabaseSchema & {
  readonly printing_control_confirmations: PrinterControlConfirmationTable;
  readonly printing_control_commands: PrinterControlCommandTable;
  readonly printer_control_events: PrinterControlEventTable;
};

export interface PrinterControlRequest {
  readonly action: PrinterControlAction;
  readonly queueEntryId?: string;
  readonly tool?: string;
  readonly targetCelsius?: number;
  readonly axes?: readonly string[];
}

export interface PrinterControlChallenge {
  readonly token: string;
  readonly expiresAt: Date;
  readonly action: PrinterControlAction;
  readonly printer: { readonly id: string; readonly name: string };
  readonly queueEntryId: string | null;
  readonly parameters: PrinterControlParameters;
  readonly safetyNotice: string;
}

export interface AcceptedPrinterControl {
  readonly commandId: string;
  readonly state: 'pending';
}
