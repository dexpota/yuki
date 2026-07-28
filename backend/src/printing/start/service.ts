import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { Kysely } from 'kysely';

import { enqueueJob } from '../../platform/jobs/index.js';
import { compatibilityRuleSetVersion } from '../compatibility/index.js';
import type { PrinterMonitoringView } from '../monitoring/index.js';
import type { AcceptedPrintStart, PrintStartDatabaseSchema, StartChallenge } from './contracts.js';

export const printStartJobType = 'printing.start';
export const printStartPayloadVersion = 1;
export const remoteStartSafetyNotice =
  'Remote software cannot verify the physical safety of the printer. Confirm the build plate, toolhead, material, and surrounding area are ready before starting.';

export class PrintStartNotFoundError extends Error {
  override readonly name = 'PrintStartNotFoundError';
}

export class PrintStartConflictError extends Error {
  override readonly name = 'PrintStartConflictError';
}

export interface StartMonitoringBoundary {
  readonly poll: (
    ownerId: string,
    printerId: string,
    reason: 'manual',
  ) => Promise<PrinterMonitoringView>;
}

export interface PrintStartServiceOptions {
  readonly now?: () => Date;
  readonly confirmationTtlMs?: number;
}

export class PrintStartService {
  readonly #now: () => Date;
  readonly #confirmationTtlMs: number;

  public constructor(
    private readonly database: Kysely<PrintStartDatabaseSchema>,
    private readonly monitoring: StartMonitoringBoundary,
    options: PrintStartServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#confirmationTtlMs = positiveDuration(
      options.confirmationTtlMs ?? 2 * 60_000,
      'confirmationTtlMs',
    );
  }

  public async issue(ownerId: string, queueEntryId: string): Promise<StartChallenge> {
    const source = await this.source(ownerId, queueEntryId);
    requireQueueHead(source.position);
    requireCurrentCompatibility(source.compatibility_snapshot, source.profile);
    const observation = await this.monitoring.poll(ownerId, source.printer_id, 'manual');
    requireReady(observation, queueEntryId);

    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#confirmationTtlMs);
    const token = randomBytes(32).toString('base64url');
    const warnings = warningMessages(source.compatibility_snapshot);
    const snapshot = {
      action: 'start',
      ownerId,
      queueEntryId,
      printer: { id: source.printer_id, name: source.display_name },
      file: {
        assetId: source.asset_id,
        filename: source.original_filename,
        byteSize: safeSize(source.byte_size),
      },
      compatibilityStatus: requiredCompatibility(source.compatibility_status),
      warnings,
      safetyNotice: remoteStartSafetyNotice,
    };
    await this.database
      .insertInto('printing_start_confirmations')
      .values({
        id: randomUUID(),
        owner_id: ownerId,
        printer_id: source.printer_id,
        queue_entry_id: queueEntryId,
        token_hash: tokenHash(token),
        challenge_snapshot: snapshot,
        issuance_idempotency_key: null,
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
    queueEntryId: string,
    token: string,
    idempotencyKey?: string,
  ): Promise<AcceptedPrintStart> {
    const hash = tokenHash(requiredToken(token));
    const requestKey = optionalIdempotencyKey(idempotencyKey) ?? `confirmation:${hash}`;
    return this.database.transaction().execute(async (transaction) => {
      const confirmation = await transaction
        .selectFrom('printing_start_confirmations')
        .selectAll()
        .where('token_hash', '=', hash)
        .where('owner_id', '=', ownerId)
        .where('queue_entry_id', '=', queueEntryId)
        .forUpdate()
        .executeTakeFirst();
      if (!confirmation) throw new PrintStartNotFoundError('Start confirmation does not exist.');
      if (confirmation.consumed_at) {
        if (confirmation.consumption_idempotency_key !== requestKey)
          throw new PrintStartConflictError('Start confirmation has already been consumed.');
        return accepted(await startedEntry(transaction, ownerId, queueEntryId));
      }
      const idempotentReplay = await transaction
        .selectFrom('printing_start_confirmations')
        .select(['queue_entry_id', 'token_hash'])
        .where('owner_id', '=', ownerId)
        .where('consumption_idempotency_key', '=', requestKey)
        .executeTakeFirst();
      if (idempotentReplay) {
        if (
          idempotentReplay.queue_entry_id !== queueEntryId ||
          idempotentReplay.token_hash !== hash
        )
          throw new PrintStartConflictError('Idempotency key belongs to another start request.');
        return accepted(await startedEntry(transaction, ownerId, queueEntryId));
      }
      const now = this.#now();
      if (confirmation.expires_at.getTime() <= now.getTime())
        throw new PrintStartConflictError('Start confirmation has expired.');

      await lockPrinter(transaction, ownerId, confirmation.printer_id);
      const source = await startSource(transaction, ownerId, queueEntryId);
      if (source.state !== 'queued')
        throw new PrintStartConflictError('Queue entry is no longer ready to start.');
      requireQueueHead(source.position);
      requireCurrentCompatibility(source.compatibility_snapshot, source.profile);
      const active = await transaction
        .selectFrom('printing_queue_entries')
        .select('id')
        .where('printer_id', '=', source.printer_id)
        .where('state', 'in', [
          'uploading',
          'uploaded',
          'starting',
          'printing',
          'paused',
          'reconciliation_required',
        ])
        .executeTakeFirst();
      if (active) throw new PrintStartConflictError('Printer already has an active job.');

      const attemptId = randomUUID();
      await transaction
        .insertInto('print_attempts')
        .values({
          id: attemptId,
          owner_id: ownerId,
          queue_entry_id: queueEntryId,
          printer_id: source.printer_id,
          model_id: source.model_id,
          model_version_id: source.model_version_id,
          asset_id: source.asset_id,
          state: 'starting',
          outcome: null,
          printer_snapshot: {
            id: source.printer_id,
            name: source.display_name,
            profileSchemaVersion: source.profile_schema_version,
            profile: source.profile,
          },
          model_snapshot: {
            id: source.model_id,
            name: source.model_name,
            versionId: source.model_version_id,
            versionLabel: source.version_label,
          },
          asset_snapshot: {
            id: source.asset_id,
            filename: source.original_filename,
            checksum: source.checksum,
            byteSize: safeSize(source.byte_size),
          },
          compatibility_snapshot: source.compatibility_snapshot ?? {},
          override_justification: source.override_justification,
          started_at: null,
          completed_at: null,
          created_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      const command = await enqueueJob(transaction, {
        type: printStartJobType,
        payloadVersion: printStartPayloadVersion,
        payload: { ownerId, queueEntryId },
        idempotencyKey: queueEntryId,
        maxAttempts: 5,
      });
      await transaction
        .updateTable('printing_queue_entries')
        .set((expression) => ({
          state: 'uploading',
          position: null,
          start_command_job_id: command.id,
          print_attempt_id: attemptId,
          error_code: null,
          error_message: null,
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('id', '=', queueEntryId)
        .where('owner_id', '=', ownerId)
        .executeTakeFirstOrThrow();
      await compactPositions(transaction, source.printer_id, now);
      await transaction
        .updateTable('printing_start_confirmations')
        .set({ consumed_at: now, consumption_idempotency_key: requestKey })
        .where('id', '=', confirmation.id)
        .executeTakeFirstOrThrow();
      return { queueEntryId, printAttemptId: attemptId, state: 'uploading' };
    });
  }

  private async source(ownerId: string, queueEntryId: string) {
    const source = await startSource(this.database, ownerId, queueEntryId);
    if (source.state !== 'queued')
      throw new PrintStartConflictError('Queue entry is not ready to start.');
    return source;
  }
}

async function startSource(
  database: Kysely<PrintStartDatabaseSchema>,
  ownerId: string,
  queueEntryId: string,
) {
  const row = await database
    .selectFrom('printing_queue_entries as entry')
    .innerJoin('printers as printer', 'printer.id', 'entry.printer_id')
    .innerJoin('catalogue_assets as asset', 'asset.id', 'entry.asset_id')
    .innerJoin('catalogue_models as model', 'model.id', 'asset.model_id')
    .innerJoin('catalogue_model_versions as version', 'version.id', 'asset.model_version_id')
    .select([
      'entry.state',
      'entry.printer_id',
      'entry.asset_id',
      'entry.compatibility_status',
      'entry.compatibility_snapshot',
      'entry.override_justification',
      'entry.position',
      'printer.display_name',
      'printer.profile_schema_version',
      'printer.profile',
      'asset.model_id',
      'asset.model_version_id',
      'asset.original_filename',
      'asset.byte_size',
      'asset.checksum',
      'model.name as model_name',
      'version.label as version_label',
    ])
    .where('entry.id', '=', queueEntryId)
    .where('entry.owner_id', '=', ownerId)
    .where('printer.owner_id', '=', ownerId)
    .executeTakeFirst();
  if (!row) throw new PrintStartNotFoundError('Queue entry does not exist.');
  return row;
}

async function lockPrinter(
  database: Kysely<PrintStartDatabaseSchema>,
  ownerId: string,
  printerId: string,
) {
  const row = await database
    .selectFrom('printers')
    .select(['id', 'enabled'])
    .where('id', '=', printerId)
    .where('owner_id', '=', ownerId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new PrintStartNotFoundError('Printer does not exist.');
  if (!row.enabled) throw new PrintStartConflictError('Printer is disabled.');
  return row;
}

async function startedEntry(
  database: Kysely<PrintStartDatabaseSchema>,
  ownerId: string,
  queueEntryId: string,
) {
  const row = await database
    .selectFrom('printing_queue_entries')
    .select(['id', 'print_attempt_id', 'state'])
    .where('id', '=', queueEntryId)
    .where('owner_id', '=', ownerId)
    .executeTakeFirst();
  if (!row?.print_attempt_id) throw new PrintStartConflictError('Print start was not accepted.');
  return row;
}

function accepted(row: {
  readonly id: string;
  readonly print_attempt_id: string | null;
  readonly state: string;
}): AcceptedPrintStart {
  if (row.state !== 'uploading' || !row.print_attempt_id)
    throw new PrintStartConflictError('Print start is no longer in its accepted state.');
  return { queueEntryId: row.id, printAttemptId: row.print_attempt_id, state: 'uploading' };
}

async function compactPositions(
  database: Kysely<PrintStartDatabaseSchema>,
  printerId: string,
  now: Date,
) {
  const rows = await database
    .selectFrom('printing_queue_entries')
    .select('id')
    .where('printer_id', '=', printerId)
    .where('state', '=', 'queued')
    .orderBy('position')
    .execute();
  for (const [position, row] of rows.entries())
    await database
      .updateTable('printing_queue_entries')
      .set((expression) => ({
        position,
        updated_at: now,
        version: expression('version', '+', 1),
      }))
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
}

function requireReady(observation: PrinterMonitoringView, queueEntryId: string): void {
  if (observation.stale || !observation.current?.online)
    throw new PrintStartConflictError('Fresh printer state is unavailable.');
  if (observation.current.operationalState !== 'operational')
    throw new PrintStartConflictError('Printer is not operational.');
  if (observation.current.activeJob.kind !== 'none')
    throw new PrintStartConflictError(
      observation.current.activeJob.applicationJobId === queueEntryId
        ? 'This job is already active.'
        : 'Printer already has an active job.',
    );
}

function warningMessages(snapshot: unknown): readonly string[] {
  if (!isObject(snapshot) || !isObject(snapshot.result) || !Array.isArray(snapshot.result.checks))
    return [];
  return snapshot.result.checks
    .filter(
      (check): check is Record<string, unknown> =>
        isObject(check) &&
        (check.status === 'warning' || check.status === 'unknown') &&
        typeof check.message === 'string',
    )
    .map((check) => String(check.message))
    .slice(0, 20);
}

function requireQueueHead(position: number | null): void {
  if (position !== 0)
    throw new PrintStartConflictError('Only the first queued job can be started.');
}

function requireCurrentCompatibility(snapshot: unknown, currentProfile: unknown): void {
  if (
    !isObject(snapshot) ||
    snapshot.ruleSetVersion !== compatibilityRuleSetVersion ||
    !isObject(snapshot.printer) ||
    !isDeepStrictEqual(snapshot.printer.profile, currentProfile)
  )
    throw new PrintStartConflictError(
      'Compatibility must be evaluated again for the current printer profile.',
    );
}

function requiredCompatibility(value: string | null): string {
  if (!value) throw new PrintStartConflictError('Compatibility evaluation is unavailable.');
  return value;
}

function safeSize(value: string | number | bigint): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Asset size is invalid.');
  return size;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function requiredToken(value: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new TypeError('Confirmation token is invalid.');
  return token;
}

function optionalIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  const result = value.trim();
  if (result.length < 1 || result.length > 200)
    throw new TypeError('Idempotency key must contain 1 to 200 characters.');
  return result;
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
