import { type Kysely, type Selectable, sql, type Transaction } from 'kysely';

import {
  type PrinterDestinationPolicy,
  type PrinterSecretVault,
  UnsafePrinterDestinationError,
} from '../printers/public.js';
import {
  type MonitoringGateway,
  MonitoringGatewayError,
  type MonitoringGatewayFailureKind,
  type PrinterFacts,
} from './gateway.js';
import type {
  ObservationJobKind,
  PollReason,
  PrinterMonitoringDatabaseSchema,
  PrinterObservationTable,
  ReconciliationState,
} from './schema.js';

export class MonitoredPrinterNotFoundError extends Error {
  override readonly name = 'MonitoredPrinterNotFoundError';
}

export class PrinterMonitoringDisabledError extends Error {
  override readonly name = 'PrinterMonitoringDisabledError';
}

export interface PrinterObservationView {
  readonly id: string;
  readonly observedAt: Date;
  readonly reason: PollReason;
  readonly online: boolean;
  readonly operationalState: string | null;
  readonly activeJob: {
    readonly kind: ObservationJobKind;
    readonly applicationJobId: string | null;
    readonly upstreamFileName: string | null;
    readonly upstreamFilePath: string | null;
    readonly upstreamFileOrigin: string | null;
  };
  readonly progressPercent: number | null;
  readonly elapsedSeconds: number | null;
  readonly remainingSeconds: number | null;
  readonly temperatures: unknown;
  readonly failureKind: MonitoringFailureKind | null;
}

export type MonitoringFailureKind = MonitoringGatewayFailureKind | 'destination_rejected';

export interface PrinterMonitoringView {
  readonly printerId: string;
  readonly freshness: 'fresh' | 'stale' | 'never_observed';
  readonly stale: boolean;
  readonly lastAttemptAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly consecutiveFailures: number;
  readonly reconciliationState: ReconciliationState | 'never_observed';
  readonly current: PrinterObservationView | null;
  readonly lastGood: PrinterObservationView | null;
}

export interface PrinterMonitoringServiceOptions {
  readonly now?: () => Date;
  readonly staleAfterMs?: number;
  readonly historyLimit?: number;
}

export class PrinterMonitoringService {
  readonly #now: () => Date;
  readonly #staleAfterMs: number;
  readonly #historyLimit: number;

  public constructor(
    private readonly database: Kysely<PrinterMonitoringDatabaseSchema>,
    private readonly secrets: PrinterSecretVault,
    private readonly destinations: PrinterDestinationPolicy,
    private readonly gateway: MonitoringGateway,
    options: PrinterMonitoringServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#staleAfterMs = positiveInteger(options.staleAfterMs ?? 30_000, 'staleAfterMs');
    this.#historyLimit = positiveInteger(options.historyLimit ?? 120, 'historyLimit');
  }

  public async poll(
    ownerId: string,
    printerId: string,
    requestedReason: PollReason = 'scheduled',
  ): Promise<PrinterMonitoringView> {
    const printer = await this.database
      .selectFrom('printers')
      .select(['id', 'owner_id', 'octoprint_url', 'encrypted_api_key', 'enabled'])
      .where('id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!printer) throw new MonitoredPrinterNotFoundError('Printer not found');
    if (!printer.enabled)
      throw new PrinterMonitoringDisabledError('Printer monitoring is disabled');

    const previous = await this.database
      .selectFrom('printer_monitoring_state')
      .select(['consecutive_failures'])
      .where('printer_id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    const observedAt = this.#now();
    try {
      const destination = await this.destinations.validate(printer.octoprint_url);
      const apiKey = this.secrets.decrypt(
        printer.encrypted_api_key,
        secretPurpose(ownerId, printerId),
      );
      const facts = await this.gateway.observe(destination, apiKey);
      const reason = previous && previous.consecutive_failures > 0 ? 'reconnect' : requestedReason;
      await this.persistSuccess(ownerId, printerId, observedAt, reason, facts);
    } catch (error) {
      if (error instanceof UnsafePrinterDestinationError) {
        await this.persistFailure(
          ownerId,
          printerId,
          observedAt,
          requestedReason,
          'destination_rejected',
        );
      } else if (error instanceof MonitoringGatewayError) {
        await this.persistFailure(ownerId, printerId, observedAt, requestedReason, error.kind);
      } else {
        throw error;
      }
    }
    return this.get(ownerId, printerId);
  }

  public async get(ownerId: string, printerId: string): Promise<PrinterMonitoringView> {
    const printer = await this.database
      .selectFrom('printers')
      .select('id')
      .where('id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!printer) throw new MonitoredPrinterNotFoundError('Printer not found');
    const [state, current, lastGood] = await Promise.all([
      this.database
        .selectFrom('printer_monitoring_state')
        .selectAll()
        .where('printer_id', '=', printerId)
        .where('owner_id', '=', ownerId)
        .executeTakeFirst(),
      this.database
        .selectFrom('printer_observations')
        .selectAll()
        .where('printer_id', '=', printerId)
        .where('owner_id', '=', ownerId)
        .orderBy('observed_at', 'desc')
        .orderBy('id', 'desc')
        .executeTakeFirst(),
      this.database
        .selectFrom('printer_observations')
        .selectAll()
        .where('printer_id', '=', printerId)
        .where('owner_id', '=', ownerId)
        .where('online', '=', true)
        .orderBy('observed_at', 'desc')
        .orderBy('id', 'desc')
        .executeTakeFirst(),
    ]);
    const stale =
      !state?.last_success_at ||
      this.#now().getTime() - state.last_success_at.getTime() > this.#staleAfterMs;
    return {
      printerId,
      freshness: state?.last_success_at ? (stale ? 'stale' : 'fresh') : 'never_observed',
      stale,
      lastAttemptAt: state?.last_attempt_at ?? null,
      lastSuccessAt: state?.last_success_at ?? null,
      lastFailureAt: state?.last_failure_at ?? null,
      consecutiveFailures: state?.consecutive_failures ?? 0,
      reconciliationState: state?.reconciliation_state ?? 'never_observed',
      current: current ? observationView(current) : null,
      lastGood: lastGood ? observationView(lastGood) : null,
    };
  }

  public async history(
    ownerId: string,
    printerId: string,
    limit = 50,
  ): Promise<readonly PrinterObservationView[]> {
    await this.requireOwnedPrinter(ownerId, printerId);
    const safeLimit = Math.min(positiveInteger(limit, 'limit'), this.#historyLimit);
    return (
      await this.database
        .selectFrom('printer_observations')
        .selectAll()
        .where('printer_id', '=', printerId)
        .where('owner_id', '=', ownerId)
        .orderBy('observed_at', 'desc')
        .orderBy('id', 'desc')
        .limit(safeLimit)
        .execute()
    ).map(observationView);
  }

  private async persistSuccess(
    ownerId: string,
    printerId: string,
    observedAt: Date,
    reason: PollReason,
    facts: PrinterFacts,
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('printer_observations')
        .values({
          owner_id: ownerId,
          printer_id: printerId,
          observed_at: observedAt,
          poll_reason: reason,
          online: true,
          operational_state: facts.state,
          active_job_kind: facts.activeJob.kind,
          application_job_id:
            facts.activeJob.kind === 'local' ? facts.activeJob.applicationJobId : null,
          upstream_file_name: facts.upstreamFile.name,
          upstream_file_path: facts.upstreamFile.path,
          upstream_file_origin: facts.upstreamFile.origin,
          progress_percent: facts.progressPercent,
          elapsed_seconds: facts.elapsedSeconds,
          remaining_seconds: facts.remainingSeconds,
          temperatures: sql`${JSON.stringify(facts.temperatures)}::jsonb`,
          failure_kind: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('printer_monitoring_state')
        .values({
          printer_id: printerId,
          owner_id: ownerId,
          last_attempt_at: observedAt,
          last_success_at: observedAt,
          last_failure_at: null,
          consecutive_failures: 0,
          last_failure_kind: null,
          reconciliation_state: reconciliationState(facts),
          updated_at: observedAt,
        })
        .onConflict((conflict) =>
          conflict.column('printer_id').doUpdateSet({
            last_attempt_at: observedAt,
            last_success_at: observedAt,
            consecutive_failures: 0,
            last_failure_kind: null,
            reconciliation_state: reconciliationState(facts),
            updated_at: observedAt,
          }),
        )
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('printers')
        .set({ connection_status: 'online', operational_state: facts.state })
        .where('id', '=', printerId)
        .where('owner_id', '=', ownerId)
        .executeTakeFirstOrThrow();
      await this.prune(transaction, ownerId, printerId);
    });
  }

  private async persistFailure(
    ownerId: string,
    printerId: string,
    observedAt: Date,
    reason: PollReason,
    kind: MonitoringFailureKind,
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('printer_observations')
        .values({
          owner_id: ownerId,
          printer_id: printerId,
          observed_at: observedAt,
          poll_reason: reason,
          online: false,
          operational_state: null,
          active_job_kind: 'none',
          application_job_id: null,
          upstream_file_name: null,
          upstream_file_path: null,
          upstream_file_origin: null,
          progress_percent: null,
          elapsed_seconds: null,
          remaining_seconds: null,
          temperatures: sql`'[]'::jsonb`,
          failure_kind: kind,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('printer_monitoring_state')
        .values({
          printer_id: printerId,
          owner_id: ownerId,
          last_attempt_at: observedAt,
          last_success_at: null,
          last_failure_at: observedAt,
          consecutive_failures: 1,
          last_failure_kind: kind,
          reconciliation_state: 'offline',
          updated_at: observedAt,
        })
        .onConflict((conflict) =>
          conflict.column('printer_id').doUpdateSet((expression) => ({
            last_attempt_at: observedAt,
            last_failure_at: observedAt,
            consecutive_failures: expression(
              'printer_monitoring_state.consecutive_failures',
              '+',
              1,
            ),
            last_failure_kind: kind,
            reconciliation_state: 'offline',
            updated_at: observedAt,
          })),
        )
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('printers')
        .set({ connection_status: 'offline' })
        .where('id', '=', printerId)
        .where('owner_id', '=', ownerId)
        .executeTakeFirstOrThrow();
      await this.prune(transaction, ownerId, printerId);
    });
  }

  private async prune(
    database: Transaction<PrinterMonitoringDatabaseSchema>,
    ownerId: string,
    printerId: string,
  ): Promise<void> {
    const rows = await database
      .selectFrom('printer_observations')
      .select(['id', 'online'])
      .where('owner_id', '=', ownerId)
      .where('printer_id', '=', printerId)
      .orderBy('observed_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    const retained = new Set(rows.slice(0, this.#historyLimit).map((row) => row.id));
    const lastGood = rows.find((row) => row.online);
    if (lastGood) retained.add(lastGood.id);
    const removable = rows.filter((row) => !retained.has(row.id)).map((row) => row.id);
    if (removable.length > 0) {
      await database
        .deleteFrom('printer_observations')
        .where('id', 'in', removable)
        .executeTakeFirst();
    }
  }

  private async requireOwnedPrinter(ownerId: string, printerId: string): Promise<void> {
    const row = await this.database
      .selectFrom('printers')
      .select('id')
      .where('id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new MonitoredPrinterNotFoundError('Printer not found');
  }
}

function reconciliationState(facts: PrinterFacts): ReconciliationState {
  switch (facts.activeJob.kind) {
    case 'local':
      return 'local_job_detected';
    case 'external':
      return 'external_job_detected';
    case 'ambiguous':
      return 'ambiguous_active_job';
    case 'none':
      return 'idle';
  }
}

function observationView(row: Selectable<PrinterObservationTable>): PrinterObservationView {
  return {
    id: row.id,
    observedAt: row.observed_at,
    reason: row.poll_reason,
    online: row.online,
    operationalState: row.operational_state,
    activeJob: {
      kind: row.active_job_kind,
      applicationJobId: row.application_job_id,
      upstreamFileName: row.upstream_file_name,
      upstreamFilePath: row.upstream_file_path,
      upstreamFileOrigin: row.upstream_file_origin,
    },
    progressPercent: row.progress_percent,
    elapsedSeconds: row.elapsed_seconds,
    remainingSeconds: row.remaining_seconds,
    temperatures: row.temperatures,
    failureKind: row.failure_kind,
  };
}

function secretPurpose(ownerId: string, printerId: string): string {
  return `octoprint-api-key:${ownerId}:${printerId}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be positive`);
  return value;
}
