import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { Kysely } from 'kysely';

import { enqueueJob } from '../../platform/jobs/index.js';
import type { BlobStore, CommittedBlob, StagedBlob } from '../../platform/storage/index.js';
import type { CataloguePortabilityDatabaseSchema } from './schema.js';
import type { CataloguePortabilityService } from './service.js';

export const catalogueExportJobType = 'catalogue.portability.export';
export const catalogueImportJobType = 'catalogue.portability.import';
export const cataloguePortabilityPayloadVersion = 1;

export interface CataloguePortabilityOperationView {
  readonly id: string;
  readonly kind: 'export' | 'import';
  readonly state: 'queued' | 'running' | 'succeeded' | 'failed';
  readonly sourceModelId: string | null;
  readonly importedModelId: string | null;
  readonly progress: number;
  readonly downloadReady: boolean;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export class CataloguePortabilityOperationNotFoundError extends Error {
  override readonly name = 'CataloguePortabilityOperationNotFoundError';
}

export class CataloguePortabilityOperations {
  public constructor(
    private readonly database: Kysely<CataloguePortabilityDatabaseSchema>,
    private readonly blobs: BlobStore,
    private readonly storageBackend: string,
    private readonly maximumUploadBytes: number,
  ) {
    if (!Number.isSafeInteger(maximumUploadBytes) || maximumUploadBytes < 1)
      throw new TypeError('maximumUploadBytes must be a positive safe integer');
  }

  public async enqueueExport(
    ownerId: string,
    modelId: string,
    idempotencyKey?: string,
  ): Promise<CataloguePortabilityOperationView> {
    if (idempotencyKey) {
      const existing = await this.#findIdempotent(ownerId, 'export', idempotencyKey);
      if (existing) return existing;
    }
    const owned = await this.database
      .selectFrom('catalogue_models')
      .select('id')
      .where('id', '=', modelId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!owned) throw new CataloguePortabilityOperationNotFoundError('Model not found');
    const operationId = randomUUID();
    const now = new Date();
    try {
      await this.database.transaction().execute(async (transaction) => {
        const job = await enqueueJob(transaction, {
          type: catalogueExportJobType,
          payloadVersion: cataloguePortabilityPayloadVersion,
          payload: { operationId },
          idempotencyKey: operationId,
          maxAttempts: 3,
        });
        await transaction
          .insertInto('catalogue_portability_operations')
          .values({
            id: operationId,
            owner_id: ownerId,
            kind: 'export',
            state: 'queued',
            source_model_id: modelId,
            imported_model_id: null,
            input_stored_object_id: null,
            output_stored_object_id: null,
            job_id: job.id,
            idempotency_key: idempotencyKey ?? null,
            error_code: null,
            error_message: null,
            created_at: now,
            updated_at: now,
            completed_at: null,
          })
          .executeTakeFirstOrThrow();
      });
    } catch (error) {
      if (idempotencyKey) {
        const raced = await this.#findIdempotent(ownerId, 'export', idempotencyKey);
        if (raced) return raced;
      }
      throw error;
    }
    return this.get(ownerId, operationId);
  }

  public async receiveImport(
    ownerId: string,
    source: AsyncIterable<Uint8Array>,
    idempotencyKey?: string,
  ): Promise<CataloguePortabilityOperationView> {
    if (idempotencyKey) {
      const existing = await this.#findIdempotent(ownerId, 'import', idempotencyKey);
      if (existing) return existing;
    }
    let staged: StagedBlob | undefined;
    let committed: CommittedBlob | undefined;
    const operationId = randomUUID();
    try {
      staged = await this.blobs.stage(bounded(source, this.maximumUploadBytes));
      committed = await this.blobs.commit(staged);
      staged = undefined;
      const objectId = randomUUID();
      const now = new Date();
      await this.database.transaction().execute(async (transaction) => {
        await transaction
          .insertInto('stored_objects')
          .values({
            id: objectId,
            backend: this.storageBackend,
            object_key: committed?.key as string,
            checksum: committed?.checksum as string,
            byte_size: committed?.size as number,
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
            owner_type: 'catalogue_portability_input',
            owner_id: operationId,
            created_at: now,
          })
          .executeTakeFirstOrThrow();
        const job = await enqueueJob(transaction, {
          type: catalogueImportJobType,
          payloadVersion: cataloguePortabilityPayloadVersion,
          payload: { operationId },
          idempotencyKey: operationId,
          maxAttempts: 3,
        });
        await transaction
          .insertInto('catalogue_portability_operations')
          .values({
            id: operationId,
            owner_id: ownerId,
            kind: 'import',
            state: 'queued',
            source_model_id: null,
            imported_model_id: null,
            input_stored_object_id: objectId,
            output_stored_object_id: null,
            job_id: job.id,
            idempotency_key: idempotencyKey ?? null,
            error_code: null,
            error_message: null,
            created_at: now,
            updated_at: now,
            completed_at: null,
          })
          .executeTakeFirstOrThrow();
      });
      return await this.get(ownerId, operationId);
    } catch (error) {
      if (staged) await this.blobs.discard(staged).catch(() => {});
      if (committed) await this.blobs.delete(committed.key).catch(() => {});
      if (idempotencyKey) {
        const raced = await this.#findIdempotent(ownerId, 'import', idempotencyKey);
        if (raced) return raced;
      }
      throw error;
    }
  }

  public async get(
    ownerId: string,
    operationId: string,
  ): Promise<CataloguePortabilityOperationView> {
    const row = await this.database
      .selectFrom('catalogue_portability_operations as operation')
      .innerJoin('jobs as job', 'job.id', 'operation.job_id')
      .select([
        'operation.id',
        'operation.kind',
        'operation.state',
        'operation.source_model_id',
        'operation.imported_model_id',
        'operation.output_stored_object_id',
        'operation.error_code',
        'operation.error_message',
        'operation.created_at',
        'operation.updated_at',
        'operation.completed_at',
        'job.progress',
      ])
      .where('operation.id', '=', operationId)
      .where('operation.owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new CataloguePortabilityOperationNotFoundError('Operation not found');
    return {
      id: row.id,
      kind: row.kind,
      state: row.state,
      sourceModelId: row.source_model_id,
      importedModelId: row.imported_model_id,
      progress: row.progress,
      downloadReady:
        row.kind === 'export' && row.state === 'succeeded' && row.output_stored_object_id !== null,
      error:
        row.error_code && row.error_message
          ? { code: row.error_code, message: row.error_message }
          : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  public async download(
    ownerId: string,
    operationId: string,
  ): Promise<{ readonly filename: string; readonly stream: Readable }> {
    const row = await this.database
      .selectFrom('catalogue_portability_operations as operation')
      .innerJoin('stored_objects as object', 'object.id', 'operation.output_stored_object_id')
      .leftJoin('catalogue_models as model', 'model.id', 'operation.source_model_id')
      .select(['operation.state', 'operation.kind', 'object.object_key', 'model.name'])
      .where('operation.id', '=', operationId)
      .where('operation.owner_id', '=', ownerId)
      .executeTakeFirst();
    if (row?.kind !== 'export' || row.state !== 'succeeded')
      throw new CataloguePortabilityOperationNotFoundError('Export download not found');
    return {
      filename: `${safeFilename(row.name ?? 'model')}.yuki.zip`,
      stream: await this.blobs.read(row.object_key),
    };
  }

  public async execute(
    operationId: string,
    portability: CataloguePortabilityService,
  ): Promise<void> {
    const operation = await this.database
      .selectFrom('catalogue_portability_operations as operation')
      .leftJoin('stored_objects as input', 'input.id', 'operation.input_stored_object_id')
      .select([
        'operation.id',
        'operation.owner_id',
        'operation.kind',
        'operation.state',
        'operation.source_model_id',
        'operation.imported_model_id',
        'input.object_key',
      ])
      .where('operation.id', '=', operationId)
      .executeTakeFirst();
    if (!operation) throw new CataloguePortabilityOperationNotFoundError('Operation not found');
    if (operation.state === 'succeeded') return;
    await this.database
      .updateTable('catalogue_portability_operations')
      .set({ state: 'running', updated_at: new Date() })
      .where('id', '=', operationId)
      .where('state', 'in', ['queued', 'running'])
      .executeTakeFirstOrThrow();
    if (operation.kind === 'export') {
      if (!operation.source_model_id) throw new Error('Export operation is incomplete');
      await this.#executeExport(
        operationId,
        operation.owner_id,
        operation.source_model_id,
        portability,
      );
      return;
    }
    if (!operation.object_key) throw new Error('Import operation is incomplete');
    const existing = await this.database
      .selectFrom('catalogue_models')
      .select('id')
      .where('id', '=', operationId)
      .where('owner_id', '=', operation.owner_id)
      .executeTakeFirst();
    const modelId =
      existing?.id ??
      (
        await portability.importModel(
          operation.owner_id,
          await this.blobs.read(operation.object_key),
          { modelId: operationId },
        )
      ).modelId;
    await this.database
      .updateTable('catalogue_portability_operations')
      .set({
        state: 'succeeded',
        imported_model_id: modelId,
        updated_at: new Date(),
        completed_at: new Date(),
      })
      .where('id', '=', operationId)
      .executeTakeFirstOrThrow();
  }

  async #executeExport(
    operationId: string,
    ownerId: string,
    modelId: string,
    portability: CataloguePortabilityService,
  ): Promise<void> {
    let committed: CommittedBlob | undefined;
    try {
      committed = await this.blobs.commit(
        await this.blobs.stage(portability.exportModel(ownerId, modelId)),
      );
      const objectId = randomUUID();
      const now = new Date();
      await this.database.transaction().execute(async (transaction) => {
        await transaction
          .insertInto('stored_objects')
          .values({
            id: objectId,
            backend: this.storageBackend,
            object_key: committed?.key as string,
            checksum: committed?.checksum as string,
            byte_size: committed?.size as number,
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
            owner_type: 'catalogue_portability_export',
            owner_id: operationId,
            created_at: now,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable('catalogue_portability_operations')
          .set({
            state: 'succeeded',
            output_stored_object_id: objectId,
            updated_at: now,
            completed_at: now,
          })
          .where('id', '=', operationId)
          .executeTakeFirstOrThrow();
      });
    } catch (error) {
      if (committed) await this.blobs.delete(committed.key).catch(() => {});
      throw error;
    }
  }

  public async markFailed(operationId: string, code: string, message: string): Promise<void> {
    await this.database
      .updateTable('catalogue_portability_operations')
      .set({
        state: 'failed',
        error_code: code.slice(0, 100),
        error_message: message.slice(0, 500),
        updated_at: new Date(),
        completed_at: new Date(),
      })
      .where('id', '=', operationId)
      .executeTakeFirstOrThrow();
  }

  async #findIdempotent(ownerId: string, kind: 'export' | 'import', key: string) {
    const row = await this.database
      .selectFrom('catalogue_portability_operations')
      .select('id')
      .where('owner_id', '=', ownerId)
      .where('kind', '=', kind)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    return row ? this.get(ownerId, row.id) : undefined;
  }
}

async function* bounded(
  source: AsyncIterable<Uint8Array>,
  maximum: number,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.length;
    if (total > maximum) throw new CataloguePortabilityUploadTooLargeError();
    yield chunk;
  }
}
function safeFilename(value: string): string {
  return (
    value
      .normalize('NFKC')
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'model'
  );
}
export class CataloguePortabilityUploadTooLargeError extends Error {
  override readonly name = 'CataloguePortabilityUploadTooLargeError';
}
