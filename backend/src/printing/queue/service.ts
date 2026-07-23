import { randomUUID } from 'node:crypto';

import { type Kysely, type Selectable, sql } from 'kysely';

import { enqueueJob } from '../../platform/jobs/index.js';
import { type CompatibilityDatabaseSchema, CompatibilityService } from '../compatibility/index.js';
import type { QueueDatabaseSchema, QueueEntryTable, QueueEntryView } from './contracts.js';

export const queueEvaluationJobType = 'printing.queue.evaluate';
export const queueEvaluationPayloadVersion = 1;

export class QueueEntryNotFoundError extends Error {
  override readonly name = 'QueueEntryNotFoundError';
}

export class QueueConflictError extends Error {
  override readonly name = 'QueueConflictError';
}

export class QueueService {
  constructor(private readonly database: Kysely<QueueDatabaseSchema>) {}

  async request(input: {
    readonly ownerId: string;
    readonly printerId: string;
    readonly assetId: string;
    readonly overrideJustification?: string;
    readonly idempotencyKey?: string;
  }): Promise<QueueEntryView> {
    const override = optionalJustification(input.overrideJustification);
    const idempotencyKey = optionalIdempotencyKey(input.idempotencyKey);
    return this.database.transaction().execute(async (transaction) => {
      await ownedPrinter(transaction, input.ownerId, input.printerId);
      if (idempotencyKey) {
        const existing = await transaction
          .selectFrom('printing_queue_entries')
          .selectAll()
          .where('owner_id', '=', input.ownerId)
          .where('idempotency_key', '=', idempotencyKey)
          .executeTakeFirst();
        if (existing) {
          if (existing.printer_id !== input.printerId || existing.asset_id !== input.assetId)
            throw new QueueConflictError('Idempotency key belongs to another queue request.');
          return view(existing);
        }
      }
      const asset = await transaction
        .selectFrom('catalogue_assets as asset')
        .innerJoin('catalogue_models as model', 'model.id', 'asset.model_id')
        .select('asset.id')
        .where('asset.id', '=', input.assetId)
        .where('asset.format', '=', 'gcode')
        .where('model.owner_id', '=', input.ownerId)
        .executeTakeFirst();
      if (!asset) throw new QueueEntryNotFoundError('G-code asset does not exist.');
      const id = randomUUID();
      const job = await enqueueJob(transaction, {
        type: queueEvaluationJobType,
        payloadVersion: queueEvaluationPayloadVersion,
        payload: { ownerId: input.ownerId, entryId: id },
        idempotencyKey: id,
        maxAttempts: 3,
      });
      const now = new Date();
      const row = await transaction
        .insertInto('printing_queue_entries')
        .values({
          id,
          owner_id: input.ownerId,
          printer_id: input.printerId,
          asset_id: input.assetId,
          evaluation_job_id: job.id,
          compatibility_evaluation_id: null,
          state: 'evaluating',
          position: null,
          compatibility_status: null,
          compatibility_snapshot: null,
          override_justification: override,
          error_code: null,
          error_message: null,
          idempotency_key: idempotencyKey,
          created_at: now,
          updated_at: now,
          version: 1,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return view(row);
    });
  }

  async list(ownerId: string, printerId: string): Promise<readonly QueueEntryView[]> {
    await this.database
      .selectFrom('printers')
      .select('id')
      .where('id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow(() => new QueueEntryNotFoundError('Printer does not exist.'));
    const rows = await this.database
      .selectFrom('printing_queue_entries')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('printer_id', '=', printerId)
      .where('state', '!=', 'removed')
      .orderBy(sql`position asc nulls last`)
      .orderBy('created_at')
      .execute();
    return rows.map(view);
  }

  async reorder(
    ownerId: string,
    printerId: string,
    entryIds: readonly string[],
  ): Promise<readonly QueueEntryView[]> {
    if (entryIds.length !== new Set(entryIds).size)
      throw new QueueConflictError('Queue order contains duplicate entries.');
    return this.database.transaction().execute(async (transaction) => {
      await ownedPrinter(transaction, ownerId, printerId);
      const queued = await transaction
        .selectFrom('printing_queue_entries')
        .select('id')
        .where('owner_id', '=', ownerId)
        .where('printer_id', '=', printerId)
        .where('state', '=', 'queued')
        .orderBy('position')
        .execute();
      const current = queued.map((row) => row.id);
      if (current.length !== entryIds.length || current.some((id) => !entryIds.includes(id)))
        throw new QueueConflictError('Queue order must contain every queued entry exactly once.');
      const now = new Date();
      for (const [position, id] of entryIds.entries())
        await transaction
          .updateTable('printing_queue_entries')
          .set((expression) => ({
            position,
            updated_at: now,
            version: expression('version', '+', 1),
          }))
          .where('id', '=', id)
          .where('owner_id', '=', ownerId)
          .where('printer_id', '=', printerId)
          .where('state', '=', 'queued')
          .executeTakeFirstOrThrow();
      return (
        await transaction
          .selectFrom('printing_queue_entries')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .where('printer_id', '=', printerId)
          .where('state', '!=', 'removed')
          .orderBy(sql`position asc nulls last`)
          .orderBy('created_at')
          .execute()
      ).map(view);
    });
  }

  async remove(ownerId: string, printerId: string, entryId: string): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await ownedPrinter(transaction, ownerId, printerId);
      const current = await ownedEntry(transaction, ownerId, printerId, entryId);
      if (current.state === 'removed') return;
      if (!['evaluating', 'blocked', 'queued', 'failed'].includes(current.state))
        throw new QueueConflictError('Queue entry cannot be removed in its current state.');
      await transaction
        .updateTable('printing_queue_entries')
        .set((expression) => ({
          state: 'removed',
          position: null,
          updated_at: new Date(),
          version: expression('version', '+', 1),
        }))
        .where('id', '=', entryId)
        .executeTakeFirstOrThrow();
      await compactPositions(transaction, printerId);
    });
  }

  async override(
    ownerId: string,
    printerId: string,
    entryId: string,
    justification: string,
  ): Promise<QueueEntryView> {
    const override = requiredJustification(justification);
    return this.database.transaction().execute(async (transaction) => {
      await ownedPrinter(transaction, ownerId, printerId);
      const current = await ownedEntry(transaction, ownerId, printerId, entryId);
      if (
        current.state !== 'blocked' ||
        (current.compatibility_status !== 'warning' && current.compatibility_status !== 'unknown')
      )
        throw new QueueConflictError('This compatibility result cannot be overridden.');
      const position = await nextPosition(transaction, printerId);
      return view(
        await transaction
          .updateTable('printing_queue_entries')
          .set((expression) => ({
            state: 'queued',
            position,
            override_justification: override,
            updated_at: new Date(),
            version: expression('version', '+', 1),
          }))
          .where('id', '=', entryId)
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
    });
  }

  async evaluationSource(
    ownerId: string,
    entryId: string,
  ): Promise<{
    readonly state: QueueEntryTable['state'];
    readonly objectKey: string;
    readonly byteSize: number;
  }> {
    const row = await this.database
      .selectFrom('printing_queue_entries as entry')
      .innerJoin('catalogue_assets as asset', 'asset.id', 'entry.asset_id')
      .innerJoin('stored_objects as object', 'object.id', 'asset.stored_object_id')
      .select(['entry.state', 'object.object_key', 'asset.byte_size'])
      .where('entry.id', '=', entryId)
      .where('entry.owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new QueueEntryNotFoundError('Queue entry does not exist.');
    const byteSize = Number(row.byte_size);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0)
      throw new Error('G-code asset size is invalid.');
    return { state: row.state, objectKey: row.object_key, byteSize };
  }

  async completeEvaluation(
    ownerId: string,
    entryId: string,
    processorFacts: unknown,
  ): Promise<QueueEntryView> {
    return this.database.transaction().execute(async (transaction) => {
      const identity = await transaction
        .selectFrom('printing_queue_entries')
        .select('printer_id')
        .where('id', '=', entryId)
        .where('owner_id', '=', ownerId)
        .executeTakeFirst();
      if (!identity) throw new QueueEntryNotFoundError('Queue entry does not exist.');
      await ownedPrinter(transaction, ownerId, identity.printer_id);
      const entry = await transaction
        .selectFrom('printing_queue_entries')
        .selectAll()
        .where('id', '=', entryId)
        .where('owner_id', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!entry) throw new QueueEntryNotFoundError('Queue entry does not exist.');
      if (entry.state === 'removed' || entry.state !== 'evaluating') return view(entry);
      const evaluation = await new CompatibilityService(
        transaction as unknown as Kysely<CompatibilityDatabaseSchema>,
      ).evaluate({
        ownerId,
        assetId: entry.asset_id,
        printerId: entry.printer_id,
        processorFacts,
      });
      const status = evaluation.snapshot.result.status;
      const mayQueue =
        status === 'compatible' ||
        ((status === 'warning' || status === 'unknown') && entry.override_justification !== null);
      const position = mayQueue ? await nextPosition(transaction, entry.printer_id) : null;
      return view(
        await transaction
          .updateTable('printing_queue_entries')
          .set((expression) => ({
            state: mayQueue ? 'queued' : 'blocked',
            position,
            compatibility_evaluation_id: evaluation.id,
            compatibility_status: status,
            compatibility_snapshot: evaluation.snapshot as unknown,
            error_code: null,
            error_message: null,
            updated_at: new Date(),
            version: expression('version', '+', 1),
          }))
          .where('id', '=', entryId)
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
    });
  }

  async failEvaluation(ownerId: string, entryId: string): Promise<void> {
    await this.database
      .updateTable('printing_queue_entries')
      .set((expression) => ({
        state: 'failed',
        error_code: 'compatibility_evaluation_failed',
        error_message: 'Compatibility evaluation could not be completed.',
        updated_at: new Date(),
        version: expression('version', '+', 1),
      }))
      .where('id', '=', entryId)
      .where('owner_id', '=', ownerId)
      .where('state', '=', 'evaluating')
      .execute();
  }
}

async function ownedPrinter(
  database: Kysely<QueueDatabaseSchema>,
  ownerId: string,
  printerId: string,
) {
  return database
    .selectFrom('printers')
    .select(['id', 'enabled'])
    .where('id', '=', printerId)
    .where('owner_id', '=', ownerId)
    .forUpdate()
    .executeTakeFirstOrThrow(() => new QueueEntryNotFoundError('Printer does not exist.'));
}

async function ownedEntry(
  database: Kysely<QueueDatabaseSchema>,
  ownerId: string,
  printerId: string,
  entryId: string,
) {
  return database
    .selectFrom('printing_queue_entries')
    .selectAll()
    .where('id', '=', entryId)
    .where('owner_id', '=', ownerId)
    .where('printer_id', '=', printerId)
    .forUpdate()
    .executeTakeFirstOrThrow(() => new QueueEntryNotFoundError('Queue entry does not exist.'));
}

async function nextPosition(database: Kysely<QueueDatabaseSchema>, printerId: string) {
  const row = await database
    .selectFrom('printing_queue_entries')
    .select((expression) => expression.fn.max<number>('position').as('position'))
    .where('printer_id', '=', printerId)
    .where('state', '=', 'queued')
    .executeTakeFirstOrThrow();
  return (row.position ?? -1) + 1;
}

async function compactPositions(database: Kysely<QueueDatabaseSchema>, printerId: string) {
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
        updated_at: new Date(),
        version: expression('version', '+', 1),
      }))
      .where('id', '=', row.id)
      .execute();
}

function optionalJustification(value: string | undefined): string | null {
  return value === undefined ? null : requiredJustification(value);
}
function requiredJustification(value: string): string {
  const result = value.trim();
  if (result.length < 1 || result.length > 500)
    throw new TypeError('Override justification must contain 1 to 500 characters.');
  return result;
}
function optionalIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  const result = value.trim();
  if (result.length < 1 || result.length > 200)
    throw new TypeError('Idempotency key must contain 1 to 200 characters.');
  return result;
}

function view(row: Selectable<QueueEntryTable>): QueueEntryView {
  return {
    id: row.id,
    printerId: row.printer_id,
    assetId: row.asset_id,
    state: row.state,
    position: row.position,
    compatibilityStatus: row.compatibility_status,
    compatibilitySnapshot: row.compatibility_snapshot,
    overrideJustification: row.override_justification,
    error:
      row.error_code && row.error_message
        ? { code: row.error_code, message: row.error_message }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}
