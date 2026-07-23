import { randomUUID } from 'node:crypto';

import type { Kysely, Selectable, Transaction } from 'kysely';

import type { BlobStore, StagedBlob, StorageSchema } from '../../platform/storage/index.js';
import { StoredObjectLifecycle } from '../../platform/storage/index.js';
import type { DetectionProcessorResult } from '../detection/contract.js';
import type { ImportDatabaseSchema, ImportFileTable } from '../schema.js';
import type {
  ImportContentProcessor,
  PreparedImportBatch,
  PreparedImportFile,
  RejectedImportFile,
} from './contracts.js';
import { isRejectedImportFile } from './contracts.js';

export class ImportBatchFailure extends Error {
  override readonly name: string = 'ImportBatchFailure';

  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class DuplicateDecisionRequiredError extends ImportBatchFailure {
  override readonly name = 'DuplicateDecisionRequiredError';

  constructor(public readonly fileIds: readonly string[]) {
    super(
      'duplicate_decision_required',
      'Confirm whether exact duplicate files should be kept',
      false,
    );
  }
}

export interface PersistedImportFile {
  readonly id: string;
  readonly fileKey: string;
  readonly originalFilename: string;
  readonly isOriginal: boolean;
  readonly storedObjectId: string | null;
  readonly status: 'accepted' | 'failed';
  readonly role: ImportFileTable['role'];
  readonly format: ImportFileTable['format'];
  readonly detectedMimeType: string | null;
  readonly byteSize: number;
  readonly checksum: string;
  readonly detection: unknown | null;
  readonly warnings: unknown;
  readonly duplicateAssetIds: readonly string[];
  readonly duplicateDecision: ImportFileTable['duplicate_decision'];
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

export class LocalImportPipeline {
  readonly #lifecycle: StoredObjectLifecycle;

  constructor(
    private readonly database: Kysely<ImportDatabaseSchema>,
    private readonly blobStore: BlobStore,
    private readonly processor: ImportContentProcessor,
    private readonly backendName = 'local',
  ) {
    this.#lifecycle = new StoredObjectLifecycle(database as unknown as Kysely<StorageSchema>);
  }

  async prepare(sessionId: string): Promise<readonly PersistedImportFile[]> {
    await this.database
      .updateTable('import_sessions')
      .set({ state: 'processing', progress: 60, updated_at: new Date() })
      .where('id', '=', sessionId)
      .where('state', '=', 'queued')
      .execute();
    const session = await this.database
      .selectFrom('import_sessions')
      .innerJoin('stored_objects', 'stored_objects.id', 'import_sessions.stored_object_id')
      .select([
        'import_sessions.id',
        'import_sessions.owner_id',
        'import_sessions.original_filename',
        'import_sessions.claimed_mime_type',
        'import_sessions.checksum',
        'import_sessions.uploaded_bytes',
        'import_sessions.stored_object_id',
        'import_sessions.processing_completed',
        'stored_objects.object_key',
      ])
      .where('import_sessions.id', '=', sessionId)
      .executeTakeFirst();
    if (!session?.checksum || !session.stored_object_id) {
      throw new ImportBatchFailure(
        'import_upload_incomplete',
        'The uploaded file is unavailable',
        false,
      );
    }

    let existing = await this.files(sessionId);
    if (session.processing_completed) return validatePrepared(existing);
    const retryableFailureIds = existing
      .filter((file) => file.status === 'failed' && file.error?.retryable)
      .map((file) => file.id);
    if (retryableFailureIds.length > 0) {
      await this.database
        .deleteFrom('import_files')
        .where('session_id', '=', sessionId)
        .where('id', 'in', retryableFailureIds)
        .execute();
      existing = await this.files(sessionId);
    }

    let batch: PreparedImportBatch;
    try {
      batch = await this.processor.inspect({
        sessionId,
        ownerId: session.owner_id,
        originalFilename: session.original_filename,
        claimedMimeType: session.claimed_mime_type,
        checksum: session.checksum,
        size: byteSize(session.uploaded_bytes),
        openOriginal: () => this.blobStore.read(session.object_key),
      });
    } catch (error) {
      const failure = processorFailure(error);
      await this.database
        .updateTable('import_sessions')
        .set({
          processing_report: {
            kind: 'processor_failure',
            failure: { code: failure.code, message: failure.message, retryable: failure.retryable },
          },
          updated_at: new Date(),
        })
        .where('id', '=', sessionId)
        .execute();
      throw failure;
    }
    try {
      validateBatch(batch.files);
      assertRetryMatches(existing, session.checksum, batch.files);

      await this.#persistOriginal(
        sessionId,
        session.owner_id,
        session.stored_object_id,
        session.original_filename,
        session.checksum,
        byteSize(session.uploaded_bytes),
        batch.kind,
        batch.originalDetection,
      );
      for (const file of batch.files) {
        if (file.fileKey === '__original__') continue;
        if (isRejectedImportFile(file)) {
          await this.#persistFailure(sessionId, file);
        } else {
          await this.#persistAccepted(sessionId, session.owner_id, file);
        }
      }
      const retryableFailure = batch.files.some(
        (file) => isRejectedImportFile(file) && file.error.retryable,
      );
      if (!retryableFailure) {
        await this.database
          .updateTable('import_sessions')
          .set({
            processing_completed: true,
            processing_report: {
              kind: batch.kind,
              fileKeys: ['__original__', ...batch.files.map((file) => file.fileKey)],
            },
            updated_at: new Date(),
          })
          .where('id', '=', sessionId)
          .where('processing_completed', '=', false)
          .executeTakeFirstOrThrow();
      }
      return validatePrepared(await this.files(sessionId));
    } finally {
      await batch.cleanup?.();
    }
  }

  async files(sessionId: string): Promise<readonly PersistedImportFile[]> {
    return importFiles(this.database, sessionId);
  }

  /** Explicit advisory decision. No bytes or logical assets are silently discarded. */
  async keepExactDuplicates(sessionId: string, fileIds: readonly string[]): Promise<void> {
    return keepImportExactDuplicates(this.database, sessionId, fileIds);
  }

  async #persistOriginal(
    sessionId: string,
    ownerId: string,
    objectId: string,
    filename: string,
    checksum: string,
    size: number,
    kind: 'file' | 'archive',
    detection: DetectionProcessorResult,
  ): Promise<void> {
    const duplicates = await duplicateAssets(this.database, ownerId, checksum);
    const now = new Date();
    await this.database
      .insertInto('import_files')
      .values({
        id: randomUUID(),
        session_id: sessionId,
        file_key: '__original__',
        original_filename: filename,
        is_original: true,
        stored_object_id: objectId,
        status: 'accepted',
        role: kind === 'archive' ? 'original_archive' : roleFor(detection.format),
        format: kind === 'archive' ? 'archive' : detection.format,
        detected_mime_type: detection.mimeType,
        byte_size: size,
        checksum,
        detection: detection as unknown,
        warnings: JSON.stringify(detection.warnings),
        duplicate_asset_ids: duplicates,
        duplicate_decision: duplicates.length > 0 ? 'required' : 'not_required',
        error_code: null,
        error_message: null,
        error_retryable: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.columns(['session_id', 'file_key']).doNothing())
      .execute();
  }

  async #persistAccepted(
    sessionId: string,
    ownerId: string,
    file: PreparedImportFile,
  ): Promise<void> {
    if (!file.open)
      throw new ImportBatchFailure(
        'processor_contract_invalid',
        'Processed file content is unavailable',
        false,
      );
    const prior = await this.database
      .selectFrom('import_files')
      .select('id')
      .where('session_id', '=', sessionId)
      .where('file_key', '=', file.fileKey)
      .executeTakeFirst();
    if (prior) return;
    let staged: StagedBlob | undefined;
    let committedKey: string | undefined;
    try {
      staged = await this.blobStore.stage(await file.open());
      if (staged.checksum !== file.checksum || staged.size !== file.size) {
        throw new ImportBatchFailure(
          'processor_output_mismatch',
          'Processed file failed integrity verification',
          false,
        );
      }
      const committed = await this.blobStore.commit(staged);
      staged = undefined;
      committedKey = committed.key;
      const objectId = randomUUID();
      const duplicates = await duplicateAssets(this.database, ownerId, file.checksum);
      const now = new Date();
      await this.database.transaction().execute(async (transaction) => {
        await this.#lifecycle.register(transaction as unknown as Transaction<StorageSchema>, {
          id: objectId,
          backend: this.backendName,
          key: committed.key,
          checksum: committed.checksum,
          size: committed.size,
        });
        await transaction
          .insertInto('import_files')
          .values({
            id: randomUUID(),
            session_id: sessionId,
            file_key: file.fileKey,
            original_filename: file.originalFilename,
            is_original: false,
            stored_object_id: objectId,
            status: 'accepted',
            role: roleFor(file.detection.format),
            format: file.detection.format,
            detected_mime_type: file.detection.mimeType,
            byte_size: file.size,
            checksum: file.checksum,
            detection: file.detection as unknown,
            warnings: JSON.stringify(file.detection.warnings),
            duplicate_asset_ids: duplicates,
            duplicate_decision: duplicates.length > 0 ? 'required' : 'not_required',
            error_code: null,
            error_message: null,
            error_retryable: null,
            created_at: now,
            updated_at: now,
          })
          .executeTakeFirstOrThrow();
      });
      committedKey = undefined;
    } catch (error) {
      if (staged) await this.blobStore.discard(staged).catch(() => {});
      if (committedKey) await this.blobStore.delete(committedKey).catch(() => {});
      throw error;
    }
  }

  async #persistFailure(sessionId: string, file: RejectedImportFile): Promise<void> {
    const now = new Date();
    await this.database
      .insertInto('import_files')
      .values({
        id: randomUUID(),
        session_id: sessionId,
        file_key: file.fileKey,
        original_filename: file.originalFilename,
        is_original: false,
        stored_object_id: null,
        status: 'failed',
        role: null,
        format: null,
        detected_mime_type: null,
        byte_size: file.size,
        checksum: file.checksum,
        detection: null,
        warnings: JSON.stringify([]),
        duplicate_asset_ids: [],
        duplicate_decision: 'not_required',
        error_code: cleanCode(file.error.code),
        error_message: cleanMessage(file.error.message),
        error_retryable: file.error.retryable,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.columns(['session_id', 'file_key']).doNothing())
      .execute();
  }
}

export async function importFiles(
  database: Kysely<ImportDatabaseSchema>,
  sessionId: string,
): Promise<readonly PersistedImportFile[]> {
  const rows = await database
    .selectFrom('import_files')
    .selectAll()
    .where('session_id', '=', sessionId)
    .orderBy('file_key')
    .execute();
  return rows.map(mapFile);
}

/** Applies an explicit advisory keep decision and resumes the same durable job. */
export async function keepImportExactDuplicates(
  database: Kysely<ImportDatabaseSchema>,
  sessionId: string,
  fileIds: readonly string[],
): Promise<void> {
  if (fileIds.length === 0) throw new TypeError('At least one import file is required');
  await database.transaction().execute(async (transaction) => {
    const uniqueIds = [...new Set(fileIds)];
    const result = await transaction
      .updateTable('import_files')
      .set({ duplicate_decision: 'keep', updated_at: new Date() })
      .where('session_id', '=', sessionId)
      .where('id', 'in', uniqueIds)
      .where('duplicate_decision', '=', 'required')
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== uniqueIds.length)
      throw new TypeError('Duplicate decision contains an unknown or already-decided file');
    const session = await transaction
      .selectFrom('import_sessions')
      .select(['job_id', 'state'])
      .where('id', '=', sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (!session?.job_id || !['queued', 'processing'].includes(session.state))
      throw new TypeError('Import session cannot resume duplicate processing');
    await transaction
      .updateTable('jobs')
      .set({
        state: 'queued',
        attempts: 0,
        progress: 60,
        next_attempt_at: new Date(),
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        last_error_code: null,
        last_error_message: null,
        completed_at: null,
        updated_at: new Date(),
      })
      .where('id', '=', session.job_id)
      .where('state', '=', 'dead_letter')
      .execute();
  });
}

function validatePrepared(files: readonly PersistedImportFile[]): readonly PersistedImportFile[] {
  const failures = files.filter((file) => file.status === 'failed');
  if (failures.length > 0) {
    throw new ImportBatchFailure(
      'import_batch_failed',
      'One or more files could not be processed',
      failures.every((file) => file.error?.retryable),
    );
  }
  const decisions = files
    .filter((file) => file.duplicateDecision === 'required')
    .map((file) => file.id);
  if (decisions.length > 0) throw new DuplicateDecisionRequiredError(decisions);
  if (files.length === 0 || files.some((file) => !file.storedObjectId)) {
    throw new ImportBatchFailure(
      'import_batch_incomplete',
      'The processed import batch is incomplete',
      true,
    );
  }
  return files;
}

function validateBatch(
  files: readonly { readonly fileKey: string; readonly checksum: string }[],
): void {
  const keys = new Set<string>();
  for (const file of files) {
    if (
      !file.fileKey ||
      file.fileKey.length > 4096 ||
      file.fileKey === '__original__' ||
      keys.has(file.fileKey)
    )
      throw new ImportBatchFailure(
        'processor_contract_invalid',
        'Processor returned an invalid file report',
        false,
      );
    if (!/^[a-f0-9]{64}$/.test(file.checksum))
      throw new ImportBatchFailure(
        'processor_contract_invalid',
        'Processor returned an invalid checksum',
        false,
      );
    keys.add(file.fileKey);
  }
}

function assertRetryMatches(
  existing: readonly PersistedImportFile[],
  originalChecksum: string,
  files: readonly { readonly fileKey: string; readonly checksum: string }[],
): void {
  const expected = new Map<string, string>([
    ['__original__', originalChecksum],
    ...files.map((file) => [file.fileKey, file.checksum] as const),
  ]);
  for (const row of existing) {
    if (expected.get(row.fileKey) !== row.checksum) {
      throw new ImportBatchFailure(
        'processor_output_changed',
        'Processor output changed while resuming the import',
        false,
      );
    }
  }
}

async function duplicateAssets(
  database: Kysely<ImportDatabaseSchema>,
  ownerId: string,
  checksum: string,
): Promise<readonly string[]> {
  const rows = await database
    .selectFrom('catalogue_assets')
    .innerJoin('catalogue_models', 'catalogue_models.id', 'catalogue_assets.model_id')
    .select('catalogue_assets.id')
    .where('catalogue_models.owner_id', '=', ownerId)
    .where('catalogue_assets.checksum', '=', checksum)
    .orderBy('catalogue_assets.id')
    .execute();
  return rows.map((row) => row.id);
}

function mapFile(row: Selectable<ImportFileTable>): PersistedImportFile {
  return {
    id: row.id,
    fileKey: row.file_key,
    originalFilename: row.original_filename,
    isOriginal: row.is_original,
    storedObjectId: row.stored_object_id,
    status: row.status,
    role: row.role,
    format: row.format,
    detectedMimeType: row.detected_mime_type,
    byteSize: byteSize(row.byte_size),
    checksum: row.checksum,
    detection: row.detection,
    warnings: row.warnings,
    duplicateAssetIds: row.duplicate_asset_ids,
    duplicateDecision: row.duplicate_decision,
    error:
      row.error_code && row.error_message && row.error_retryable !== null
        ? { code: row.error_code, message: row.error_message, retryable: row.error_retryable }
        : null,
  };
}

function roleFor(
  format: NonNullable<ImportFileTable['format']>,
): NonNullable<ImportFileTable['role']> {
  if (['stl', '3mf', 'obj', 'step'].includes(format)) return 'geometry';
  if (format === 'gcode') return 'gcode';
  if (format === 'image') return 'image';
  if (format === 'document') return 'document';
  return 'other';
}
function byteSize(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Import byte size is invalid');
  return result;
}
function cleanCode(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9_]/g, '_')
      .slice(0, 80) || 'file_processing_failed'
  );
}
function cleanMessage(value: string): string {
  const printable = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('');
  return (
    printable.replaceAll(/\s+/g, ' ').trim().slice(0, 300) || 'The file could not be processed'
  );
}

function processorFailure(error: unknown): ImportBatchFailure {
  if (error instanceof ImportBatchFailure) return error;
  if (typeof error === 'object' && error !== null) {
    if (
      'code' in error &&
      typeof error.code === 'string' &&
      'message' in error &&
      typeof error.message === 'string' &&
      'retryable' in error &&
      typeof error.retryable === 'boolean'
    ) {
      return new ImportBatchFailure(
        cleanCode(error.code),
        cleanMessage(error.message),
        error.retryable,
      );
    }
    if ('failure' in error && typeof error.failure === 'object' && error.failure !== null) {
      const failure = error.failure;
      if (
        'code' in failure &&
        typeof failure.code === 'string' &&
        'message' in failure &&
        typeof failure.message === 'string' &&
        'retryable' in failure &&
        typeof failure.retryable === 'boolean'
      ) {
        return new ImportBatchFailure(
          cleanCode(failure.code),
          cleanMessage(failure.message),
          failure.retryable,
        );
      }
    }
  }
  return new ImportBatchFailure(
    'processor_unavailable',
    'The file processor could not complete the request',
    true,
  );
}
