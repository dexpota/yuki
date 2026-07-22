import { randomUUID } from 'node:crypto';

import type { Kysely, Selectable, Transaction } from 'kysely';

import {
  insertDraftAsset,
  insertDraftVersion,
  insertModel,
  publishVersion,
} from '../catalogue/index.js';
import { enqueueJob } from '../platform/jobs/index.js';
import type { BlobStore, StagedBlob, StorageSchema } from '../platform/storage/index.js';
import { StoredObjectLifecycle } from '../platform/storage/index.js';
import type { ImportDatabaseSchema, ImportSessionTable } from './schema.js';

export const localImportJobType = 'import.local-file';
export const localImportPayloadVersion = 1;

export interface LocalUploadInput {
  readonly ownerId: string;
  readonly originalFilename: string;
  readonly claimedMimeType: string;
  readonly modelName: string;
  readonly idempotencyKey?: string;
  readonly source: AsyncIterable<Uint8Array>;
}

export interface LocalImportLimits {
  readonly maximumUploadBytes: number;
  readonly progressIntervalBytes?: number;
}

export interface ImportSessionView {
  readonly id: string;
  readonly state: ImportSessionTable['state'];
  readonly originalFilename: string;
  readonly modelName: string;
  readonly uploadedBytes: number;
  readonly checksum: string | null;
  readonly progress: number;
  readonly modelId: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export class UploadLimitExceededError extends Error {
  override readonly name = 'UploadLimitExceededError';
}

export class ImportSessionNotFoundError extends Error {
  override readonly name = 'ImportSessionNotFoundError';
}

export class LocalImportService {
  readonly #lifecycle: StoredObjectLifecycle;

  constructor(
    private readonly database: Kysely<ImportDatabaseSchema>,
    private readonly blobStore: BlobStore,
    private readonly limits: LocalImportLimits,
    private readonly backendName = 'local',
  ) {
    if (!Number.isSafeInteger(limits.maximumUploadBytes) || limits.maximumUploadBytes < 1) {
      throw new TypeError('maximumUploadBytes must be a positive safe integer');
    }
    if (
      limits.progressIntervalBytes !== undefined &&
      (!Number.isSafeInteger(limits.progressIntervalBytes) || limits.progressIntervalBytes < 1)
    ) {
      throw new TypeError('progressIntervalBytes must be a positive safe integer');
    }
    this.#lifecycle = new StoredObjectLifecycle(database as unknown as Kysely<StorageSchema>);
  }

  async receive(input: LocalUploadInput): Promise<ImportSessionView> {
    validateUpload(input);
    const existing = input.idempotencyKey
      ? await this.findByIdempotencyKey(input.ownerId, input.idempotencyKey)
      : undefined;
    if (existing) return existing;

    const sessionId = randomUUID();
    const now = new Date();
    try {
      await this.database
        .insertInto('import_sessions')
        .values({
          id: sessionId,
          owner_id: input.ownerId,
          state: 'receiving',
          original_filename: input.originalFilename.trim(),
          claimed_mime_type: input.claimedMimeType.trim(),
          model_name: input.modelName.trim(),
          idempotency_key: input.idempotencyKey?.trim() ?? null,
          uploaded_bytes: 0,
          checksum: null,
          stored_object_id: null,
          job_id: null,
          model_id: null,
          progress: 0,
          error_code: null,
          error_message: null,
          created_at: now,
          updated_at: now,
          completed_at: null,
        })
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (input.idempotencyKey) {
        const raced = await this.findByIdempotencyKey(input.ownerId, input.idempotencyKey);
        if (raced) return raced;
      }
      throw error;
    }

    let stagedHandle: Pick<StagedBlob, 'stageKey'> | undefined;
    let committedKey: string | undefined;
    try {
      const staged = await this.blobStore.stage(
        this.#boundedSource(sessionId, input.source, this.limits.maximumUploadBytes),
      );
      stagedHandle = staged;
      const committed = await this.blobStore.commit(staged);
      stagedHandle = undefined;
      committedKey = committed.key;
      const objectId = randomUUID();
      await this.database.transaction().execute(async (transaction) => {
        await this.#lifecycle.register(transaction as unknown as Transaction<StorageSchema>, {
          id: objectId,
          backend: this.backendName,
          key: committed.key,
          checksum: committed.checksum,
          size: committed.size,
        });
        const job = await enqueueJob(transaction, {
          type: localImportJobType,
          payloadVersion: localImportPayloadVersion,
          payload: { sessionId },
          idempotencyKey: sessionId,
          maxAttempts: 3,
        });
        await transaction
          .updateTable('import_sessions')
          .set({
            state: 'queued',
            uploaded_bytes: committed.size,
            checksum: committed.checksum,
            stored_object_id: objectId,
            job_id: job.id,
            progress: 50,
            updated_at: new Date(),
          })
          .where('id', '=', sessionId)
          .where('state', '=', 'receiving')
          .executeTakeFirstOrThrow();
      });
      return await this.get(input.ownerId, sessionId);
    } catch (error) {
      if (stagedHandle !== undefined) await this.blobStore.discard(stagedHandle).catch(() => {});
      if (committedKey !== undefined) await this.blobStore.delete(committedKey).catch(() => {});
      await this.#recordUploadFailure(sessionId, error);
      throw error;
    }
  }

  async get(ownerId: string, sessionId: string): Promise<ImportSessionView> {
    const row = await this.database
      .selectFrom('import_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new ImportSessionNotFoundError('Import session does not exist');
    return mapSession(row);
  }

  async publish(sessionId: string): Promise<ImportSessionView> {
    return this.database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom('import_sessions')
        .selectAll()
        .where('id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!session) throw new ImportSessionNotFoundError('Import session does not exist');
      if (session.state === 'succeeded') return mapSession(session);
      if (session.state === 'failed') throw new Error('A failed import cannot be published');
      if (!session.stored_object_id || !session.checksum || !session.job_id) {
        throw new Error('Import session upload is incomplete');
      }

      await transaction
        .updateTable('import_sessions')
        .set({ state: 'processing', progress: 70, updated_at: new Date() })
        .where('id', '=', sessionId)
        .executeTakeFirstOrThrow();

      const modelId = randomUUID();
      const versionId = randomUUID();
      const publishedAt = new Date();
      const processedFiles = await transaction
        .selectFrom('import_files')
        .selectAll()
        .where('session_id', '=', sessionId)
        .orderBy('file_key')
        .execute();
      if (processedFiles.length > 0 && !session.processing_completed) {
        throw new Error('An incomplete import batch cannot be published');
      }
      if (processedFiles.some((file) => file.status === 'failed')) {
        throw new Error('A failed import batch cannot be published');
      }
      if (processedFiles.some((file) => file.duplicate_decision === 'required')) {
        throw new Error('Duplicate decisions are required before publication');
      }
      await insertModel(transaction, {
        id: modelId,
        owner_id: session.owner_id,
        name: session.model_name,
        description: '',
        import_source: 'upload',
        source_url: null,
        creator: null,
        license: null,
        favorite: false,
        current_version_id: versionId,
        cover_asset_id: null,
        print_count: 0,
        last_printed_at: null,
        created_at: publishedAt,
        updated_at: publishedAt,
      });
      await insertDraftVersion(transaction, {
        id: versionId,
        model_id: modelId,
        label: 'v1',
        change_note: null,
        metadata_schema_version: 1,
        metadata_snapshot: { name: session.model_name, importSessionId: session.id },
        created_at: publishedAt,
        published_at: null,
      });
      const assets =
        processedFiles.length > 0
          ? processedFiles.map((file) => {
              if (
                !file.stored_object_id ||
                !file.role ||
                !file.format ||
                !file.detected_mime_type
              ) {
                throw new Error('Processed import file is incomplete');
              }
              return {
                storedObjectId: file.stored_object_id,
                role: file.role,
                format: file.format,
                originalFilename: file.original_filename,
                mimeType: file.detected_mime_type,
                byteSize: parseByteSize(file.byte_size),
                checksum: file.checksum,
              };
            })
          : [
              {
                storedObjectId: session.stored_object_id,
                role: 'other' as const,
                format: 'other' as const,
                originalFilename: session.original_filename,
                mimeType: session.claimed_mime_type,
                byteSize: parseByteSize(session.uploaded_bytes),
                checksum: session.checksum,
              },
            ];
      for (const asset of assets) {
        await insertDraftAsset(transaction, {
          id: randomUUID(),
          model_id: modelId,
          model_version_id: versionId,
          stored_object_id: asset.storedObjectId,
          role: asset.role,
          format: asset.format,
          original_filename: asset.originalFilename,
          detected_mime_type: asset.mimeType,
          byte_size: asset.byteSize,
          checksum: asset.checksum,
          imported_at: publishedAt,
          published_at: null,
        });
      }
      await publishVersion(transaction, versionId, publishedAt);
      const completed = await transaction
        .updateTable('import_sessions')
        .set({
          state: 'succeeded',
          model_id: modelId,
          progress: 100,
          error_code: null,
          error_message: null,
          updated_at: publishedAt,
          completed_at: publishedAt,
        })
        .where('id', '=', sessionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return mapSession(completed);
    });
  }

  async markProcessingFailure(
    sessionId: string,
    failure: { readonly code: string; readonly message: string },
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom('import_sessions')
        .select(['state', 'stored_object_id'])
        .where('id', '=', sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!session || session.state === 'succeeded' || session.state === 'failed') return;
      const now = new Date();
      await transaction
        .updateTable('import_sessions')
        .set({
          state: 'failed',
          error_code: sanitizeCode(failure.code),
          error_message: sanitizeMessage(failure.message),
          updated_at: now,
          completed_at: now,
        })
        .where('id', '=', sessionId)
        .executeTakeFirstOrThrow();
      const stagedObjects = await transaction
        .selectFrom('import_files')
        .select('stored_object_id')
        .where('session_id', '=', sessionId)
        .where('is_original', '=', false)
        .where('stored_object_id', 'is not', null)
        .execute();
      const stagedIds = stagedObjects.flatMap((row) =>
        row.stored_object_id ? [row.stored_object_id] : [],
      );
      if (stagedIds.length > 0) {
        await transaction
          .updateTable('import_files')
          .set({ stored_object_id: null, updated_at: now })
          .where('session_id', '=', sessionId)
          .where('is_original', '=', false)
          .execute();
        await transaction
          .updateTable('stored_objects')
          .set({ state: 'pending_delete', delete_after: now, updated_at: now })
          .where('id', 'in', stagedIds)
          .where('reference_count', '=', 0)
          .execute();
      }
    });
  }

  private async findByIdempotencyKey(
    ownerId: string,
    key: string,
  ): Promise<ImportSessionView | undefined> {
    const row = await this.database
      .selectFrom('import_sessions')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('idempotency_key', '=', key.trim())
      .executeTakeFirst();
    return row ? mapSession(row) : undefined;
  }

  async *#boundedSource(
    sessionId: string,
    source: AsyncIterable<Uint8Array>,
    maximumBytes: number,
  ): AsyncGenerator<Uint8Array> {
    let bytes = 0;
    let reported = 0;
    const interval = this.limits.progressIntervalBytes ?? 1024 * 1024;
    for await (const chunk of source) {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) {
        throw new UploadLimitExceededError('Upload exceeds the configured byte limit');
      }
      if (bytes - reported >= interval) {
        reported = bytes;
        await this.database
          .updateTable('import_sessions')
          .set({ uploaded_bytes: bytes, progress: 20, updated_at: new Date() })
          .where('id', '=', sessionId)
          .where('state', '=', 'receiving')
          .execute();
      }
      yield chunk;
    }
  }

  async #recordUploadFailure(sessionId: string, error: unknown): Promise<void> {
    const limit = hasCause(error, UploadLimitExceededError);
    await this.database
      .updateTable('import_sessions')
      .set({
        state: 'failed',
        error_code: limit ? 'upload_too_large' : 'upload_failed',
        error_message: limit
          ? 'Upload exceeds the configured byte limit'
          : 'The upload could not be stored',
        updated_at: new Date(),
        completed_at: new Date(),
      })
      .where('id', '=', sessionId)
      .where('state', '=', 'receiving')
      .execute();
  }
}

function validateUpload(input: LocalUploadInput): void {
  boundedText(input.ownerId, 1, 100, 'ownerId');
  boundedText(input.originalFilename, 1, 1024, 'originalFilename');
  boundedText(input.claimedMimeType, 1, 255, 'claimedMimeType');
  boundedText(input.modelName, 1, 300, 'modelName');
  if (input.idempotencyKey !== undefined)
    boundedText(input.idempotencyKey, 1, 200, 'idempotencyKey');
}

function boundedText(value: string, minimum: number, maximum: number, name: string): void {
  if (typeof value !== 'string' || value.trim().length < minimum || value.trim().length > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
}

function parseByteSize(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Uploaded byte size is invalid');
  return parsed;
}

function mapSession(row: Selectable<ImportSessionTable>): ImportSessionView {
  return {
    id: row.id,
    state: row.state,
    originalFilename: row.original_filename,
    modelName: row.model_name,
    uploadedBytes: parseByteSize(row.uploaded_bytes),
    checksum: row.checksum,
    progress: row.progress,
    modelId: row.model_id,
    error:
      row.error_code && row.error_message
        ? { code: row.error_code, message: row.error_message }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function hasCause(error: unknown, kind: new (message?: string) => Error): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (Object.prototype.isPrototypeOf.call(kind.prototype, current)) return true;
    current = current.cause;
  }
  return false;
}

function sanitizeCode(code: string): string {
  return code.trim().slice(0, 100) || 'import_failed';
}

function sanitizeMessage(message: string): string {
  return message.trim().slice(0, 500) || 'The import could not be completed';
}
