import type { Kysely, Transaction } from 'kysely';

import type { MonitoringGateway, PrinterFacts } from '../monitoring/index.js';
import {
  type PrinterDestination,
  type PrinterDestinationPolicy,
  type PrinterSecretVault,
  UnsafePrinterDestinationError,
} from '../printers/public.js';
import type {
  PrinterControlAction,
  PrinterControlDatabaseSchema,
  PrinterControlParameters,
} from './contracts.js';
import { type PrinterControlGateway, PrinterControlGatewayError } from './gateway.js';

export class PrinterControlCommandError extends Error {
  override readonly name = 'PrinterControlCommandError';
  public constructor(public readonly code: string) {
    super('Printer control command failed');
  }
}

interface ControlCommandSource {
  readonly id: string;
  readonly owner_id: string;
  readonly printer_id: string;
  readonly queue_entry_id: string | null;
  readonly action: PrinterControlAction;
  readonly parameters: unknown;
  readonly state: 'pending' | 'completed' | 'failed' | 'reconciliation_required';
  readonly octoprint_url: string;
  readonly encrypted_api_key: string;
  readonly enabled: boolean;
}

export class PrinterControlCommandService {
  public constructor(
    private readonly database: Kysely<PrinterControlDatabaseSchema>,
    private readonly secrets: PrinterSecretVault,
    private readonly destinations: PrinterDestinationPolicy,
    private readonly gateway: PrinterControlGateway,
    private readonly monitoring: MonitoringGateway,
  ) {}

  public async execute(ownerId: string, commandId: string): Promise<void> {
    const command = await this.source(ownerId, commandId);
    if (command.state !== 'pending') return;
    if (!command.enabled) {
      await this.finish(command, 'failed', 'printer_disabled');
      throw new PrinterControlCommandError('printer_disabled');
    }
    let destination: PrinterDestination;
    let apiKey: string;
    try {
      destination = await this.destinations.validate(command.octoprint_url);
      apiKey = this.secrets.decrypt(
        command.encrypted_api_key,
        `octoprint-api-key:${ownerId}:${command.printer_id}`,
      );
    } catch (error) {
      const code =
        error instanceof UnsafePrinterDestinationError
          ? 'destination_rejected'
          : 'printer_credentials_unavailable';
      await this.finish(command, 'failed', code);
      throw new PrinterControlCommandError(code);
    }
    const parameters = command.parameters as PrinterControlParameters;
    const before = await this.observe(destination, apiKey, command);
    if (!commandStillValid(command.action, command.queue_entry_id, parameters, before)) {
      await this.finish(command, 'failed', 'fresh_state_conflict');
      throw new PrinterControlCommandError('fresh_state_conflict');
    }
    try {
      await this.gateway.execute(destination, apiKey, command.action, parameters);
      await this.complete(command);
    } catch (error) {
      if (!(error instanceof PrinterControlGatewayError)) throw error;
      if (error.ambiguous) {
        const after = await this.observe(destination, apiKey, command);
        if (reconciled(command.action, command.queue_entry_id, parameters, after)) {
          await this.complete(command);
          return;
        }
        await this.finish(command, 'reconciliation_required', `ambiguous_${error.kind}`);
        return;
      }
      await this.finish(command, 'failed', `octoprint_${error.kind}`);
      throw new PrinterControlCommandError(`octoprint_${error.kind}`);
    }
  }

  private async observe(
    destination: PrinterDestination,
    apiKey: string,
    command: ControlCommandSource,
  ): Promise<PrinterFacts> {
    try {
      return await this.monitoring.observe(destination, apiKey);
    } catch {
      await this.finish(command, 'reconciliation_required', 'observation_failed');
      throw new PrinterControlCommandError('observation_failed');
    }
  }

  private async source(ownerId: string, commandId: string): Promise<ControlCommandSource> {
    const row = await this.database
      .selectFrom('printing_control_commands as command')
      .innerJoin('printers as printer', 'printer.id', 'command.printer_id')
      .select([
        'command.id',
        'command.owner_id',
        'command.printer_id',
        'command.queue_entry_id',
        'command.action',
        'command.parameters',
        'command.state',
        'printer.octoprint_url',
        'printer.encrypted_api_key',
        'printer.enabled',
      ])
      .where('command.id', '=', commandId)
      .where('command.owner_id', '=', ownerId)
      .where('printer.owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new PrinterControlCommandError('control_command_not_found');
    return row;
  }

  private async complete(command: ControlCommandSource): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const now = new Date();
      if (command.queue_entry_id && ['pause', 'resume', 'cancel'].includes(command.action)) {
        const projected = await projectJobControl(transaction, command, now);
        if (!projected) {
          await finishInTransaction(
            transaction,
            command,
            'reconciliation_required',
            'local_state_changed',
            now,
          );
          return;
        }
      }
      await finishInTransaction(transaction, command, 'completed', 'command_completed', now);
    });
  }

  private async finish(
    command: ControlCommandSource,
    state: 'failed' | 'reconciliation_required',
    code: string,
  ): Promise<void> {
    await this.database
      .transaction()
      .execute((transaction) => finishInTransaction(transaction, command, state, code, new Date()));
  }
}

async function projectJobControl(
  transaction: Transaction<PrinterControlDatabaseSchema>,
  command: ControlCommandSource,
  now: Date,
): Promise<boolean> {
  const state =
    command.action === 'pause' ? 'paused' : command.action === 'resume' ? 'printing' : 'cancelled';
  const expectedState =
    command.action === 'pause'
      ? (['printing'] as const)
      : command.action === 'resume'
        ? (['paused'] as const)
        : (['printing', 'paused'] as const);
  const entry = await transaction
    .updateTable('printing_queue_entries')
    .set((expression) => ({
      state,
      error_code: null,
      error_message: null,
      updated_at: now,
      version: expression('version', '+', 1),
    }))
    .where('id', '=', command.queue_entry_id as string)
    .where('owner_id', '=', command.owner_id)
    .where('state', 'in', expectedState)
    .returning('print_attempt_id')
    .executeTakeFirst();
  if (!entry?.print_attempt_id) return false;
  const attemptId = entry.print_attempt_id;
  await transaction
    .updateTable('print_attempts')
    .set((expression) => ({
      state,
      ...(state === 'cancelled' ? { outcome: 'cancelled' as const, completed_at: now } : {}),
      updated_at: now,
      version: expression('version', '+', 1),
    }))
    .where('id', '=', attemptId)
    .where('owner_id', '=', command.owner_id)
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto('print_attempt_events')
    .values({
      owner_id: command.owner_id,
      print_attempt_id: attemptId,
      kind:
        command.action === 'pause'
          ? 'paused'
          : command.action === 'resume'
            ? 'resumed'
            : 'cancelled',
      facts: { source: 'printer_control', commandId: command.id },
      recorded_at: now,
    })
    .executeTakeFirstOrThrow();
  return true;
}

async function finishInTransaction(
  transaction: Transaction<PrinterControlDatabaseSchema>,
  command: ControlCommandSource,
  state: 'completed' | 'failed' | 'reconciliation_required',
  code: string,
  now: Date,
): Promise<void> {
  const updated = await transaction
    .updateTable('printing_control_commands')
    .set({ state, result_code: code, completed_at: now })
    .where('id', '=', command.id)
    .where('state', '=', 'pending')
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) return;
  await transaction
    .insertInto('printer_control_events')
    .values({
      owner_id: command.owner_id,
      printer_id: command.printer_id,
      command_id: command.id,
      queue_entry_id: command.queue_entry_id,
      action: command.action,
      outcome: state,
      facts: { code },
      recorded_at: now,
    })
    .executeTakeFirstOrThrow();
}

function commandStillValid(
  action: PrinterControlAction,
  queueEntryId: string | null,
  parameters: PrinterControlParameters,
  facts: PrinterFacts,
): boolean {
  if (action === 'pause' || action === 'resume' || action === 'cancel') {
    if (facts.activeJob.kind !== 'local' || facts.activeJob.applicationJobId !== queueEntryId)
      return false;
    return action === 'pause'
      ? facts.state === 'printing'
      : action === 'resume'
        ? facts.state === 'paused'
        : facts.state === 'printing' || facts.state === 'paused';
  }
  if (action === 'home') return facts.state === 'operational' && facts.activeJob.kind === 'none';
  if (!['operational', 'printing', 'paused'].includes(facts.state)) return false;
  const component =
    action === 'set_tool_temperature' ? (parameters as { readonly tool: string }).tool : 'bed';
  return facts.temperatures.some((temperature) => temperature.component === component);
}

function reconciled(
  action: PrinterControlAction,
  queueEntryId: string | null,
  parameters: PrinterControlParameters,
  facts: PrinterFacts,
): boolean {
  if (action === 'pause')
    return (
      facts.state === 'paused' &&
      facts.activeJob.kind === 'local' &&
      facts.activeJob.applicationJobId === queueEntryId
    );
  if (action === 'resume')
    return (
      facts.state === 'printing' &&
      facts.activeJob.kind === 'local' &&
      facts.activeJob.applicationJobId === queueEntryId
    );
  if (action === 'cancel') return facts.activeJob.kind === 'none';
  if (action === 'home') return false;
  const expected = parameters as { readonly targetCelsius: number; readonly tool?: string };
  const component = action === 'set_tool_temperature' ? expected.tool : 'bed';
  return facts.temperatures.some(
    (temperature) =>
      temperature.component === component && temperature.targetCelsius === expected.targetCelsius,
  );
}
