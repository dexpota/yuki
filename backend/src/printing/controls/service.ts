import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';

import { enqueueJob } from '../../platform/jobs/index.js';
import type { PrinterMonitoringView } from '../monitoring/index.js';
import type {
  AcceptedPrinterControl,
  PrinterControlAction,
  PrinterControlChallenge,
  PrinterControlDatabaseSchema,
  PrinterControlParameters,
  PrinterControlRequest,
} from './contracts.js';

export const printerControlJobType = 'printing.control';
export const printerControlPayloadVersion = 1;
export const printerControlSafetyNotice =
  'Confirm the printer is physically safe to control and that the requested action matches its current state.';

export class PrinterControlNotFoundError extends Error {
  override readonly name = 'PrinterControlNotFoundError';
}

export class PrinterControlConflictError extends Error {
  override readonly name = 'PrinterControlConflictError';
}

export interface PrinterControlMonitoringBoundary {
  readonly poll: (
    ownerId: string,
    printerId: string,
    reason: 'manual',
  ) => Promise<PrinterMonitoringView>;
}

export class PrinterControlService {
  readonly #now: () => Date;
  readonly #ttlMs: number;

  public constructor(
    private readonly database: Kysely<PrinterControlDatabaseSchema>,
    private readonly monitoring: PrinterControlMonitoringBoundary,
    options: { readonly now?: () => Date; readonly confirmationTtlMs?: number } = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.confirmationTtlMs ?? 2 * 60_000;
  }

  public async issue(
    ownerId: string,
    printerId: string,
    request: PrinterControlRequest,
  ): Promise<PrinterControlChallenge> {
    const action = requiredAction(request.action);
    const parameters = parametersFor(request);
    const queueEntryId =
      action === 'pause' || action === 'resume' || action === 'cancel'
        ? requiredId(request.queueEntryId, 'queueEntryId')
        : null;
    const printer = await this.printer(ownerId, printerId);
    const observation = await this.monitoring.poll(ownerId, printerId, 'manual');
    await validateFreshState(
      this.database,
      ownerId,
      printerId,
      action,
      queueEntryId,
      parameters,
      observation,
    );
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#ttlMs);
    const token = randomBytes(32).toString('base64url');
    const snapshot = {
      action,
      printer: { id: printerId, name: printer.display_name },
      queueEntryId,
      parameters,
      safetyNotice: printerControlSafetyNotice,
    };
    await this.database
      .insertInto('printing_control_confirmations')
      .values({
        id: randomUUID(),
        owner_id: ownerId,
        printer_id: printerId,
        queue_entry_id: queueEntryId,
        action,
        parameters,
        token_hash: tokenHash(token),
        challenge_snapshot: snapshot,
        consumption_idempotency_key: null,
        created_at: now,
        expires_at: expiresAt,
        consumed_at: null,
      })
      .executeTakeFirstOrThrow();
    return { token, expiresAt, ...snapshot };
  }

  public async accept(
    ownerId: string,
    printerId: string,
    token: string,
    idempotencyKey?: string,
  ): Promise<AcceptedPrinterControl> {
    const hash = tokenHash(requiredToken(token));
    const requestKey = optionalKey(idempotencyKey) ?? `confirmation:${hash}`;
    const confirmation = await this.database
      .selectFrom('printing_control_confirmations')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('printer_id', '=', printerId)
      .where('token_hash', '=', hash)
      .executeTakeFirst();
    if (!confirmation)
      throw new PrinterControlNotFoundError('Control confirmation does not exist.');
    if (confirmation.consumed_at) {
      if (confirmation.consumption_idempotency_key !== requestKey)
        throw new PrinterControlConflictError('Control confirmation has already been consumed.');
      return existingCommand(this.database, confirmation.id);
    }
    if (confirmation.expires_at.getTime() <= this.#now().getTime())
      throw new PrinterControlConflictError('Control confirmation has expired.');
    const observation = await this.monitoring.poll(ownerId, printerId, 'manual');
    await validateFreshState(
      this.database,
      ownerId,
      printerId,
      confirmation.action,
      confirmation.queue_entry_id,
      confirmation.parameters as PrinterControlParameters,
      observation,
    );

    return this.database.transaction().execute(async (transaction) => {
      const locked = await transaction
        .selectFrom('printing_control_confirmations')
        .selectAll()
        .where('id', '=', confirmation.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (locked.consumed_at) {
        if (locked.consumption_idempotency_key !== requestKey)
          throw new PrinterControlConflictError('Control confirmation has already been consumed.');
        return existingCommand(transaction, locked.id);
      }
      const replay = await transaction
        .selectFrom('printing_control_confirmations')
        .select('id')
        .where('owner_id', '=', ownerId)
        .where('consumption_idempotency_key', '=', requestKey)
        .executeTakeFirst();
      if (replay && replay.id !== locked.id)
        throw new PrinterControlConflictError(
          'Idempotency key belongs to another control request.',
        );
      const now = this.#now();
      if (locked.expires_at.getTime() <= now.getTime())
        throw new PrinterControlConflictError('Control confirmation has expired.');
      const commandId = randomUUID();
      const job = await enqueueJob(transaction, {
        type: printerControlJobType,
        payloadVersion: printerControlPayloadVersion,
        payload: { ownerId, commandId },
        idempotencyKey: commandId,
        maxAttempts: 1,
      });
      await transaction
        .insertInto('printing_control_commands')
        .values({
          id: commandId,
          owner_id: ownerId,
          printer_id: printerId,
          queue_entry_id: locked.queue_entry_id,
          confirmation_id: locked.id,
          job_id: job.id,
          action: locked.action,
          parameters: locked.parameters,
          state: 'pending',
          result_code: null,
          created_at: now,
          completed_at: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('printer_control_events')
        .values({
          owner_id: ownerId,
          printer_id: printerId,
          command_id: commandId,
          queue_entry_id: locked.queue_entry_id,
          action: locked.action,
          outcome: 'accepted',
          facts: { parameters: locked.parameters },
          recorded_at: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('printing_control_confirmations')
        .set({ consumed_at: now, consumption_idempotency_key: requestKey })
        .where('id', '=', locked.id)
        .executeTakeFirstOrThrow();
      return { commandId, state: 'pending' as const };
    });
  }

  private async printer(ownerId: string, printerId: string) {
    const printer = await this.database
      .selectFrom('printers')
      .select(['display_name', 'enabled'])
      .where('id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!printer) throw new PrinterControlNotFoundError('Printer does not exist.');
    if (!printer.enabled) throw new PrinterControlConflictError('Printer is disabled.');
    return printer;
  }
}

async function validateFreshState(
  database: Kysely<PrinterControlDatabaseSchema>,
  ownerId: string,
  printerId: string,
  action: PrinterControlAction,
  queueEntryId: string | null,
  parameters: PrinterControlParameters,
  observation: PrinterMonitoringView,
): Promise<void> {
  if (observation.stale || !observation.current?.online)
    throw new PrinterControlConflictError('Fresh printer state is unavailable.');
  const facts = observation.current;
  if (action === 'pause' || action === 'resume' || action === 'cancel') {
    if (!queueEntryId) throw new TypeError('queueEntryId is required for job controls.');
    const entry = await database
      .selectFrom('printing_queue_entries')
      .select(['id', 'state'])
      .where('id', '=', queueEntryId)
      .where('owner_id', '=', ownerId)
      .where('printer_id', '=', printerId)
      .executeTakeFirst();
    if (!entry) throw new PrinterControlNotFoundError('Print job does not exist.');
    if (facts.activeJob.kind !== 'local' || facts.activeJob.applicationJobId !== queueEntryId)
      throw new PrinterControlConflictError('The selected Yuki job is not active on this printer.');
    const expected = action === 'resume' ? 'paused' : action === 'pause' ? 'printing' : null;
    if (expected && (facts.operationalState !== expected || entry.state !== expected))
      throw new PrinterControlConflictError(
        `The print job cannot be ${action}d in its current state.`,
      );
    if (
      action === 'cancel' &&
      facts.operationalState !== 'printing' &&
      facts.operationalState !== 'paused'
    )
      throw new PrinterControlConflictError(
        'The print job cannot be cancelled in its current state.',
      );
    return;
  }
  if (
    facts.operationalState !== 'operational' &&
    facts.operationalState !== 'printing' &&
    facts.operationalState !== 'paused'
  )
    throw new PrinterControlConflictError('Printer is not available for this control.');
  if (action === 'home') {
    if (facts.operationalState !== 'operational' || facts.activeJob.kind !== 'none')
      throw new PrinterControlConflictError('Axes can only be homed while the printer is idle.');
    return;
  }
  const component =
    action === 'set_tool_temperature' ? (parameters as { readonly tool: string }).tool : 'bed';
  if (!temperatureComponents(facts.temperatures).includes(component))
    throw new PrinterControlConflictError(`Printer does not report a ${component} heater.`);
}

function temperatureComponents(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((temperature) =>
    temperature &&
    typeof temperature === 'object' &&
    typeof (temperature as Record<string, unknown>).component === 'string'
      ? [String((temperature as Record<string, unknown>).component)]
      : [],
  );
}

function parametersFor(request: PrinterControlRequest): PrinterControlParameters {
  switch (requiredAction(request.action)) {
    case 'set_tool_temperature': {
      const tool = request.tool?.trim();
      if (!tool || !/^tool(?:[0-9]|1[0-5])$/.test(tool))
        throw new TypeError('tool must be tool0 through tool15.');
      return { tool, targetCelsius: boundedTemperature(request.targetCelsius, 300, 'tool') };
    }
    case 'set_bed_temperature':
      return { targetCelsius: boundedTemperature(request.targetCelsius, 130, 'bed') };
    case 'home': {
      const axes = [...new Set(request.axes ?? [])];
      if (axes.length < 1 || axes.some((axis) => !['x', 'y', 'z'].includes(axis)))
        throw new TypeError('axes must contain one or more of x, y, and z.');
      return { axes: axes as ('x' | 'y' | 'z')[] };
    }
    default:
      return {};
  }
}

function requiredAction(value: unknown): PrinterControlAction {
  if (
    !['pause', 'resume', 'cancel', 'set_tool_temperature', 'set_bed_temperature', 'home'].includes(
      String(value),
    )
  )
    throw new TypeError('action is not supported.');
  return value as PrinterControlAction;
}

function boundedTemperature(value: unknown, maximum: number, component: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum)
    throw new TypeError(`${component} targetCelsius must be between 0 and ${maximum}.`);
  return value;
}

function requiredToken(value: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new TypeError('Confirmation token is invalid.');
  return token;
}

function requiredId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${name} is required for job controls.`);
  return value.trim();
}

function optionalKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  const result = value.trim();
  if (result.length < 1 || result.length > 200)
    throw new TypeError('Idempotency key must contain 1 to 200 characters.');
  return result;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function existingCommand(
  database: Kysely<PrinterControlDatabaseSchema>,
  confirmationId: string,
): Promise<AcceptedPrinterControl> {
  const command = await database
    .selectFrom('printing_control_commands')
    .select(['id', 'state'])
    .where('confirmation_id', '=', confirmationId)
    .executeTakeFirstOrThrow();
  if (command.state !== 'pending')
    throw new PrinterControlConflictError('Control command is no longer pending.');
  return { commandId: command.id, state: 'pending' };
}
