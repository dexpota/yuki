import { randomUUID } from 'node:crypto';

import { type Kysely, type Selectable, sql, type Transaction } from 'kysely';

import type { BlobStore, CommittedBlob } from '../../platform/storage/index.js';
import type { PrinterFacts } from '../monitoring/index.js';
import type { PrintAttemptTable } from '../start/index.js';
import type {
  PrintAttemptPhotoTable,
  PrintAttemptSource,
  PrintAttemptView,
  PrintHistoryDatabaseSchema,
  PrintOutcome,
  PrintPhotoView,
} from './contracts.js';

export class PrintHistoryNotFoundError extends Error {
  override readonly name = 'PrintHistoryNotFoundError';
}

export class PrintHistoryConflictError extends Error {
  override readonly name = 'PrintHistoryConflictError';
}

export interface ManualPrintAttemptInput {
  readonly ownerId: string;
  readonly modelId: string;
  readonly modelVersionId: string;
  readonly assetId: string;
  readonly printerId: string;
  readonly source: Exclude<PrintAttemptSource, 'remote'>;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly outcome: PrintOutcome;
  readonly notes?: string;
  readonly idempotencyKey?: string;
}

export interface PrintHistoryListInput {
  readonly ownerId: string;
  readonly modelId?: string;
  readonly printerId?: string;
  readonly limit?: number;
}

export interface PrintPhotoInput {
  readonly ownerId: string;
  readonly attemptId: string;
  readonly filename: string;
  readonly declaredMimeType?: string;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly idempotencyKey?: string;
}

export class PrintHistoryService {
  public constructor(
    private readonly database: Kysely<PrintHistoryDatabaseSchema>,
    private readonly blobs: BlobStore,
    private readonly storageBackend = 'local',
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async list(input: PrintHistoryListInput): Promise<readonly PrintAttemptView[]> {
    const limit = boundedLimit(input.limit ?? 50);
    let query = this.database
      .selectFrom('print_attempts')
      .selectAll()
      .where('owner_id', '=', input.ownerId);
    if (input.modelId) query = query.where('model_id', '=', input.modelId);
    if (input.printerId) query = query.where('printer_id', '=', input.printerId);
    const attempts = await query
      .orderBy(sql`coalesce(completed_at, started_at, created_at) desc`)
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return this.withPhotos(attempts);
  }

  public async get(ownerId: string, attemptId: string): Promise<PrintAttemptView> {
    const attempt = await this.ownedAttempt(ownerId, attemptId);
    return (await this.withPhotos([attempt]))[0] as PrintAttemptView;
  }

  public async audit(ownerId: string, attemptId: string) {
    await this.ownedAttempt(ownerId, attemptId);
    const [events, outcomeCorrections, noteRevisions] = await Promise.all([
      this.database
        .selectFrom('print_attempt_events')
        .select(['id', 'kind', 'facts', 'recorded_at'])
        .where('owner_id', '=', ownerId)
        .where('print_attempt_id', '=', attemptId)
        .orderBy('recorded_at')
        .orderBy('id')
        .execute(),
      this.database
        .selectFrom('print_attempt_outcome_corrections')
        .select(['id', 'previous_outcome', 'outcome', 'reason', 'corrected_at'])
        .where('owner_id', '=', ownerId)
        .where('print_attempt_id', '=', attemptId)
        .orderBy('corrected_at')
        .orderBy('id')
        .execute(),
      this.database
        .selectFrom('print_attempt_note_revisions')
        .select(['id', 'notes', 'created_at'])
        .where('owner_id', '=', ownerId)
        .where('print_attempt_id', '=', attemptId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    ]);
    return { events, outcomeCorrections, noteRevisions };
  }

  public async createManual(input: ManualPrintAttemptInput): Promise<PrintAttemptView> {
    validateTimes(input.startedAt, input.completedAt, this.now());
    const notes = normalizedNotes(input.notes ?? '');
    const idempotencyKey = optionalKey(input.idempotencyKey);
    const attemptId = await this.database.transaction().execute(async (transaction) => {
      if (idempotencyKey) {
        const existing = await transaction
          .selectFrom('print_attempts')
          .select([
            'id',
            'model_id',
            'model_version_id',
            'asset_id',
            'printer_id',
            'source',
            'started_at',
            'completed_at',
            'outcome',
            'notes',
          ])
          .where('owner_id', '=', input.ownerId)
          .where('creation_idempotency_key', '=', idempotencyKey)
          .executeTakeFirst();
        if (existing) {
          if (
            existing.model_id !== input.modelId ||
            existing.model_version_id !== input.modelVersionId ||
            existing.asset_id !== input.assetId ||
            existing.printer_id !== input.printerId ||
            existing.source !== input.source ||
            existing.started_at?.getTime() !== input.startedAt.getTime() ||
            existing.completed_at?.getTime() !== input.completedAt.getTime() ||
            existing.outcome !== input.outcome ||
            existing.notes !== notes
          )
            throw new PrintHistoryConflictError(
              'Idempotency key belongs to another manual attempt.',
            );
          return existing.id;
        }
      }
      const source = await manualSource(transaction, input);
      const id = randomUUID();
      const now = this.now();
      await transaction
        .insertInto('print_attempts')
        .values({
          id,
          owner_id: input.ownerId,
          queue_entry_id: null,
          printer_id: input.printerId,
          model_id: input.modelId,
          model_version_id: input.modelVersionId,
          asset_id: input.assetId,
          state: stateForOutcome(input.outcome),
          outcome: input.outcome,
          printer_snapshot: {
            id: input.printerId,
            name: source.display_name,
            profileSchemaVersion: source.profile_schema_version,
            profile: source.profile,
          },
          model_snapshot: {
            id: input.modelId,
            name: source.model_name,
            versionId: input.modelVersionId,
            versionLabel: source.version_label,
          },
          asset_snapshot: {
            id: input.assetId,
            filename: source.original_filename,
            checksum: source.checksum,
            byteSize: byteSize(source.byte_size),
          },
          compatibility_snapshot: {},
          override_justification: null,
          started_at: input.startedAt,
          completed_at: input.completedAt,
          created_at: now,
          updated_at: now,
          source: input.source,
          notes,
          statistics: {},
          creation_idempotency_key: idempotencyKey,
          version: 1,
        })
        .executeTakeFirstOrThrow();
      await appendEvent(
        transaction,
        input.ownerId,
        id,
        eventForOutcome(input.outcome),
        { outcome: input.outcome },
        input.completedAt,
      );
      if (notes)
        await transaction
          .insertInto('print_attempt_note_revisions')
          .values({
            id: randomUUID(),
            owner_id: input.ownerId,
            print_attempt_id: id,
            notes,
            idempotency_key: null,
            created_at: now,
          })
          .executeTakeFirstOrThrow();
      await incrementModelProjection(transaction, input.ownerId, input.modelId, input.completedAt);
      return id;
    });
    return this.get(input.ownerId, attemptId);
  }

  public async correctOutcome(
    ownerId: string,
    attemptId: string,
    outcome: PrintOutcome,
    reason: string,
    idempotencyKey?: string,
  ): Promise<PrintAttemptView> {
    const correctionReason = requiredText(reason, 1_000, 'Correction reason');
    const requestKey = optionalKey(idempotencyKey);
    await this.database.transaction().execute(async (transaction) => {
      if (requestKey) {
        const existing = await transaction
          .selectFrom('print_attempt_outcome_corrections')
          .select(['print_attempt_id', 'outcome', 'reason'])
          .where('owner_id', '=', ownerId)
          .where('idempotency_key', '=', requestKey)
          .executeTakeFirst();
        if (existing) {
          if (
            existing.print_attempt_id !== attemptId ||
            existing.outcome !== outcome ||
            existing.reason !== correctionReason
          )
            throw new PrintHistoryConflictError(
              'Idempotency key belongs to another outcome correction.',
            );
          return;
        }
      }
      const attempt = await lockedAttempt(transaction, ownerId, attemptId);
      if (!attempt.completed_at)
        throw new PrintHistoryConflictError('Outcome can be corrected only after completion.');
      const now = this.now();
      await transaction
        .insertInto('print_attempt_outcome_corrections')
        .values({
          id: randomUUID(),
          owner_id: ownerId,
          print_attempt_id: attemptId,
          previous_outcome: attempt.outcome,
          outcome,
          reason: correctionReason,
          idempotency_key: requestKey,
          corrected_at: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('print_attempts')
        .set((expression) => ({
          outcome,
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
    });
    return this.get(ownerId, attemptId);
  }

  public async updateNotes(
    ownerId: string,
    attemptId: string,
    value: string,
    idempotencyKey?: string,
  ): Promise<PrintAttemptView> {
    const notes = normalizedNotes(value);
    const requestKey = optionalKey(idempotencyKey);
    await this.database.transaction().execute(async (transaction) => {
      if (requestKey) {
        const existing = await transaction
          .selectFrom('print_attempt_note_revisions')
          .select(['print_attempt_id', 'notes'])
          .where('owner_id', '=', ownerId)
          .where('idempotency_key', '=', requestKey)
          .executeTakeFirst();
        if (existing) {
          if (existing.print_attempt_id !== attemptId || existing.notes !== notes)
            throw new PrintHistoryConflictError(
              'Idempotency key belongs to another note revision.',
            );
          return;
        }
      }
      await lockedAttempt(transaction, ownerId, attemptId);
      const now = this.now();
      await transaction
        .insertInto('print_attempt_note_revisions')
        .values({
          id: randomUUID(),
          owner_id: ownerId,
          print_attempt_id: attemptId,
          notes,
          idempotency_key: requestKey,
          created_at: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('print_attempts')
        .set((expression) => ({
          notes,
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
    });
    return this.get(ownerId, attemptId);
  }

  public async addPhoto(input: PrintPhotoInput): Promise<PrintPhotoView> {
    const filename = requiredText(input.filename, 1_024, 'Photo filename');
    const requestKey = optionalKey(input.idempotencyKey);
    if (requestKey) {
      const existing = await this.database
        .selectFrom('print_attempt_photos')
        .selectAll()
        .where('owner_id', '=', input.ownerId)
        .where('idempotency_key', '=', requestKey)
        .executeTakeFirst();
      if (existing) {
        if (
          existing.print_attempt_id !== input.attemptId ||
          existing.original_filename !== filename
        )
          throw new PrintHistoryConflictError('Idempotency key belongs to another photo.');
        return photoView(existing);
      }
    }
    await this.ownedAttempt(input.ownerId, input.attemptId);
    const inspection = imageInspection(input.bytes);
    const staged = await this.blobs.stage(inspection.bytes);
    let committed: CommittedBlob | undefined;
    try {
      if (staged.size < 1 || staged.size > maximumPhotoBytes)
        throw new TypeError('Photo must contain 1 byte through 25 MiB.');
      const mimeType = inspection.mimeType();
      if (
        input.declaredMimeType &&
        input.declaredMimeType !== 'application/octet-stream' &&
        input.declaredMimeType !== mimeType
      )
        throw new TypeError('Declared photo type does not match its content.');
      committed = await this.blobs.commit(staged);
      const photo = await this.registerPhoto(input, filename, mimeType, committed, requestKey);
      return photo;
    } catch (error) {
      if (committed) await this.blobs.delete(committed.key);
      else await this.blobs.discard(staged);
      throw error;
    }
  }

  public async photoSource(ownerId: string, attemptId: string, photoId: string) {
    const row = await this.database
      .selectFrom('print_attempt_photos as photo')
      .innerJoin('stored_objects as object', 'object.id', 'photo.stored_object_id')
      .select([
        'photo.original_filename',
        'photo.detected_mime_type',
        'photo.byte_size',
        'photo.checksum',
        'object.object_key',
      ])
      .where('photo.id', '=', photoId)
      .where('photo.owner_id', '=', ownerId)
      .where('photo.print_attempt_id', '=', attemptId)
      .executeTakeFirst();
    if (!row) throw new PrintHistoryNotFoundError('Print photograph does not exist.');
    return {
      filename: row.original_filename,
      mimeType: row.detected_mime_type,
      byteSize: byteSize(row.byte_size),
      checksum: row.checksum,
      stream: await this.blobs.read(row.object_key),
    };
  }

  public async observe(
    ownerId: string,
    printerId: string,
    facts: PrinterFacts,
    observedAt: Date,
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const entry = await transaction
        .selectFrom('printing_queue_entries')
        .select(['id', 'state', 'print_attempt_id'])
        .where('owner_id', '=', ownerId)
        .where('printer_id', '=', printerId)
        .where('state', 'in', ['printing', 'paused', 'reconciliation_required'])
        .forUpdate()
        .executeTakeFirst();
      if (!entry?.print_attempt_id) return;
      if (facts.activeJob.kind === 'local') {
        if (facts.activeJob.applicationJobId !== entry.id) return;
        const state = facts.state === 'paused' ? 'paused' : 'printing';
        const now = observedAt;
        if (entry.state !== state) {
          await transaction
            .updateTable('printing_queue_entries')
            .set((expression) => ({
              state,
              updated_at: now,
              version: expression('version', '+', 1),
            }))
            .where('id', '=', entry.id)
            .executeTakeFirstOrThrow();
          await appendEvent(
            transaction,
            ownerId,
            entry.print_attempt_id,
            state === 'paused' ? 'paused' : entry.state === 'paused' ? 'resumed' : 'printing',
            observationStatistics(facts, observedAt),
            observedAt,
          );
        }
        await updateAttemptStatistics(
          transaction,
          entry.print_attempt_id,
          state,
          facts,
          observedAt,
        );
        return;
      }
      if (facts.activeJob.kind !== 'none') return;
      const previous = await transaction
        .selectFrom('printer_observations')
        .select(['active_job_kind', 'application_job_id'])
        .where('owner_id', '=', ownerId)
        .where('printer_id', '=', printerId)
        .where('active_job_kind', '!=', 'none')
        .orderBy('observed_at', 'desc')
        .orderBy('id', 'desc')
        .executeTakeFirst();
      if (previous?.active_job_kind !== 'local' || previous.application_job_id !== entry.id) return;
      const outcome: PrintOutcome =
        facts.progressPercent === 100
          ? 'successful'
          : facts.state === 'error'
            ? 'failed'
            : 'unknown';
      const queueState = outcome === 'failed' ? 'failed' : 'completed';
      const event = outcome === 'failed' ? 'failed' : 'completed';
      await transaction
        .updateTable('printing_queue_entries')
        .set((expression) => ({
          state: queueState,
          updated_at: observedAt,
          version: expression('version', '+', 1),
        }))
        .where('id', '=', entry.id)
        .executeTakeFirstOrThrow();
      const attempt = await transaction
        .updateTable('print_attempts')
        .set((expression) => ({
          state: queueState,
          outcome,
          statistics: observationStatistics(facts, observedAt),
          completed_at: observedAt,
          updated_at: observedAt,
          version: expression('version', '+', 1),
        }))
        .where('id', '=', entry.print_attempt_id)
        .returning('model_id')
        .executeTakeFirstOrThrow();
      await appendEvent(
        transaction,
        ownerId,
        entry.print_attempt_id,
        event,
        { outcome, ...observationStatistics(facts, observedAt) },
        observedAt,
      );
      if (attempt.model_id)
        await incrementModelProjection(transaction, ownerId, attempt.model_id, observedAt);
    });
  }

  private async registerPhoto(
    input: PrintPhotoInput,
    filename: string,
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp',
    committed: CommittedBlob,
    idempotencyKey: string | null,
  ): Promise<PrintPhotoView> {
    const photoId = randomUUID();
    const objectId = randomUUID();
    const now = this.now();
    return this.database.transaction().execute(async (transaction) => {
      await lockedAttempt(transaction, input.ownerId, input.attemptId);
      await transaction
        .insertInto('stored_objects')
        .values({
          id: objectId,
          backend: this.storageBackend,
          object_key: committed.key,
          checksum: committed.checksum,
          byte_size: committed.size,
          state: 'committed',
          reference_count: 1,
          delete_after: null,
          deletion_error: null,
          created_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('stored_object_references')
        .values({
          stored_object_id: objectId,
          owner_type: 'print_attempt_photo',
          owner_id: photoId,
          created_at: now,
        })
        .executeTakeFirstOrThrow();
      const row = await transaction
        .insertInto('print_attempt_photos')
        .values({
          id: photoId,
          owner_id: input.ownerId,
          print_attempt_id: input.attemptId,
          stored_object_id: objectId,
          original_filename: filename,
          detected_mime_type: mimeType,
          byte_size: committed.size,
          checksum: committed.checksum,
          idempotency_key: idempotencyKey,
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return photoView(row);
    });
  }

  private async ownedAttempt(ownerId: string, attemptId: string) {
    const row = await this.database
      .selectFrom('print_attempts')
      .selectAll()
      .where('id', '=', attemptId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new PrintHistoryNotFoundError('Print attempt does not exist.');
    return row;
  }

  private async withPhotos(
    attempts: readonly Selectable<PrintAttemptTable>[],
  ): Promise<readonly PrintAttemptView[]> {
    if (attempts.length === 0) return [];
    const photos = await this.database
      .selectFrom('print_attempt_photos')
      .selectAll()
      .where(
        'print_attempt_id',
        'in',
        attempts.map((attempt) => attempt.id),
      )
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const byAttempt = Map.groupBy(photos, (photo) => photo.print_attempt_id);
    return attempts.map((attempt) =>
      attemptView(attempt, (byAttempt.get(attempt.id) ?? []).map(photoView)),
    );
  }
}

async function manualSource(
  database: Transaction<PrintHistoryDatabaseSchema>,
  input: ManualPrintAttemptInput,
) {
  const row = await database
    .selectFrom('catalogue_assets as asset')
    .innerJoin('catalogue_models as model', 'model.id', 'asset.model_id')
    .innerJoin('catalogue_model_versions as version', 'version.id', 'asset.model_version_id')
    .innerJoin('printers as printer', 'printer.owner_id', 'model.owner_id')
    .select([
      'asset.original_filename',
      'asset.byte_size',
      'asset.checksum',
      'model.name as model_name',
      'version.label as version_label',
      'printer.display_name',
      'printer.profile_schema_version',
      'printer.profile',
    ])
    .where('model.owner_id', '=', input.ownerId)
    .where('model.id', '=', input.modelId)
    .where('version.id', '=', input.modelVersionId)
    .where('asset.id', '=', input.assetId)
    .where('asset.format', '=', 'gcode')
    .where('printer.id', '=', input.printerId)
    .where('printer.owner_id', '=', input.ownerId)
    .executeTakeFirst();
  if (!row)
    throw new PrintHistoryNotFoundError('Model version, G-code asset, or printer does not exist.');
  return row;
}

async function lockedAttempt(
  database: Transaction<PrintHistoryDatabaseSchema>,
  ownerId: string,
  attemptId: string,
) {
  const row = await database
    .selectFrom('print_attempts')
    .selectAll()
    .where('id', '=', attemptId)
    .where('owner_id', '=', ownerId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new PrintHistoryNotFoundError('Print attempt does not exist.');
  return row;
}

async function appendEvent(
  database: Transaction<PrintHistoryDatabaseSchema>,
  ownerId: string,
  attemptId: string,
  kind: Selectable<PrintHistoryDatabaseSchema['print_attempt_events']>['kind'],
  facts: Record<string, unknown>,
  recordedAt: Date,
) {
  await database
    .insertInto('print_attempt_events')
    .values({
      owner_id: ownerId,
      print_attempt_id: attemptId,
      kind,
      facts,
      recorded_at: recordedAt,
    })
    .executeTakeFirstOrThrow();
}

async function incrementModelProjection(
  database: Transaction<PrintHistoryDatabaseSchema>,
  ownerId: string,
  modelId: string,
  completedAt: Date,
) {
  await database
    .updateTable('catalogue_models')
    .set((expression) => ({
      print_count: expression('print_count', '+', 1),
      last_printed_at: sql`greatest(coalesce(last_printed_at, ${completedAt}), ${completedAt})`,
      updated_at: sql`greatest(updated_at, ${completedAt})`,
    }))
    .where('id', '=', modelId)
    .where('owner_id', '=', ownerId)
    .executeTakeFirstOrThrow();
}

async function updateAttemptStatistics(
  database: Transaction<PrintHistoryDatabaseSchema>,
  attemptId: string,
  state: 'printing' | 'paused',
  facts: PrinterFacts,
  observedAt: Date,
) {
  await database
    .updateTable('print_attempts')
    .set((expression) => ({
      state,
      statistics: observationStatistics(facts, observedAt),
      updated_at: observedAt,
      version: expression('version', '+', 1),
    }))
    .where('id', '=', attemptId)
    .executeTakeFirstOrThrow();
}

function observationStatistics(facts: PrinterFacts, observedAt: Date) {
  return {
    observedAt: observedAt.toISOString(),
    progressPercent: facts.progressPercent,
    elapsedSeconds: facts.elapsedSeconds,
    remainingSeconds: facts.remainingSeconds,
    upstreamFile: facts.upstreamFile,
  };
}

function attemptView(
  row: Selectable<PrintAttemptTable>,
  photos: readonly PrintPhotoView[],
): PrintAttemptView {
  return {
    id: row.id,
    source: row.source,
    queueEntryId: row.queue_entry_id,
    printerId: row.printer_id,
    modelId: row.model_id,
    modelVersionId: row.model_version_id,
    assetId: row.asset_id,
    state: row.state,
    outcome: row.outcome,
    notes: row.notes,
    statistics: row.statistics,
    printerSnapshot: row.printer_snapshot,
    modelSnapshot: row.model_snapshot,
    assetSnapshot: row.asset_snapshot,
    compatibilitySnapshot: row.compatibility_snapshot,
    overrideJustification: row.override_justification,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    photos,
  };
}

function photoView(row: Selectable<PrintAttemptPhotoTable>): PrintPhotoView {
  return {
    id: row.id,
    filename: row.original_filename,
    mimeType: row.detected_mime_type,
    byteSize: byteSize(row.byte_size),
    checksum: row.checksum,
    createdAt: row.created_at,
  };
}

const maximumPhotoBytes = 25 * 1024 * 1024;

function imageInspection(source: AsyncIterable<Uint8Array>) {
  const header: number[] = [];
  let size = 0;
  return {
    bytes: (async function* () {
      for await (const chunk of source) {
        size += chunk.byteLength;
        if (size > maximumPhotoBytes) throw new TypeError('Photo exceeds 25 MiB.');
        for (const byte of chunk.subarray(0, Math.max(0, 16 - header.length))) header.push(byte);
        yield chunk;
      }
    })(),
    mimeType: (): 'image/jpeg' | 'image/png' | 'image/webp' => detectImage(header),
  };
}

function detectImage(bytes: readonly number[]): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10') return 'image/png';
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  throw new TypeError('Photo must be a JPEG, PNG, or WebP image.');
}

function stateForOutcome(outcome: PrintOutcome): 'completed' | 'failed' | 'cancelled' {
  return outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'cancelled' : 'completed';
}

function eventForOutcome(outcome: PrintOutcome): 'completed' | 'failed' | 'cancelled' {
  return stateForOutcome(outcome);
}

function validateTimes(startedAt: Date, completedAt: Date, now: Date) {
  if (
    !Number.isFinite(startedAt.getTime()) ||
    !Number.isFinite(completedAt.getTime()) ||
    startedAt > completedAt ||
    completedAt > now
  )
    throw new TypeError('Print timestamps must be valid, ordered, and not in the future.');
}

function normalizedNotes(value: string): string {
  if (typeof value !== 'string' || value.length > 10_000)
    throw new TypeError('Notes must contain at most 10000 characters.');
  return value;
}

function requiredText(value: string, maximum: number, name: string): string {
  const text = value.trim();
  if (!text || text.length > maximum)
    throw new TypeError(`${name} must contain 1 to ${maximum} characters.`);
  return text;
}

function optionalKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  return requiredText(value, 200, 'Idempotency key');
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100)
    throw new TypeError('History limit must be between 1 and 100.');
  return value;
}

function byteSize(value: string | number | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Stored byte size is invalid.');
  return result;
}
