import { randomUUID } from 'node:crypto';

import type { Kysely, Selectable } from 'kysely';

import type {
  ArtifactIdentity,
  ArtifactView,
  GeneratedArtifactTable,
  PreviewDatabaseSchema,
  ReadyArtifact,
  ReadyArtifactBatchItem,
} from './contracts.js';
import { mayStartArtifact, sanitizedCompletion } from './workflow.js';

type Row = Selectable<GeneratedArtifactTable>;

export class CataloguePreviewService {
  constructor(private readonly database: Kysely<PreviewDatabaseSchema>) {}

  async request(ownerId: string, identity: ArtifactIdentity): Promise<ArtifactView> {
    const now = new Date();
    const row = await this.database
      .insertInto('catalogue_generated_artifacts')
      .values({
        id: randomUUID(),
        owner_id: ownerId,
        source_asset_id: identity.sourceAssetId,
        kind: identity.kind,
        status: 'queued',
        generator: identity.generator,
        generator_version: identity.generatorVersion,
        stored_object_id: null,
        mime_type: null,
        byte_size: null,
        dimensions: null,
        summary: null,
        failure_code: null,
        failure_message: null,
        attempt: 0,
        created_at: now,
        updated_at: now,
        completed_at: null,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['source_asset_id', 'kind', 'generator', 'generator_version'])
          .doUpdateSet({
            updated_at: now,
          }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    if (row.owner_id !== ownerId) throw new Error('Artifact request is not owner scoped.');
    return view(row);
  }

  async start(ownerId: string, artifactId: string): Promise<ArtifactView> {
    return this.database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom('catalogue_generated_artifacts')
        .selectAll()
        .where('id', '=', artifactId)
        .where('owner_id', '=', ownerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!mayStartArtifact(row.status)) return view(row);
      return view(
        await transaction
          .updateTable('catalogue_generated_artifacts')
          .set({
            status: 'processing',
            attempt: row.attempt + 1,
            failure_code: null,
            failure_message: null,
            completed_at: null,
            updated_at: new Date(),
          })
          .where('id', '=', artifactId)
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
    });
  }

  async ready(ownerId: string, artifactId: string, artifact: ReadyArtifact): Promise<ArtifactView> {
    if (!Number.isSafeInteger(artifact.byteSize) || artifact.byteSize < 0)
      throw new RangeError('Artifact byte size is invalid.');
    return this.database.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom('catalogue_generated_artifacts')
        .selectAll()
        .where('id', '=', artifactId)
        .where('owner_id', '=', ownerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.status === 'ready') {
        if (current.stored_object_id !== artifact.storedObjectId)
          throw new Error('A ready artifact cannot be replaced by a retry.');
        return view(current);
      }
      if (current.status !== 'processing') throw new Error('Artifact is not being processed.');
      const referenced = await transaction
        .insertInto('stored_object_references')
        .values({
          stored_object_id: artifact.storedObjectId,
          owner_type: 'catalogue_generated_artifact',
          owner_id: artifactId,
          created_at: new Date(),
        })
        .onConflict((conflict) => conflict.columns(['owner_type', 'owner_id']).doNothing())
        .returning('stored_object_id')
        .executeTakeFirst();
      if (!referenced) {
        const existingReference = await transaction
          .selectFrom('stored_object_references')
          .select('stored_object_id')
          .where('owner_type', '=', 'catalogue_generated_artifact')
          .where('owner_id', '=', artifactId)
          .executeTakeFirstOrThrow();
        if (existingReference.stored_object_id !== artifact.storedObjectId)
          throw new Error('Artifact already owns a different stored object reference.');
      }
      if (referenced)
        await transaction
          .updateTable('stored_objects')
          .set((expression) => ({
            reference_count: expression('reference_count', '+', 1),
            updated_at: new Date(),
          }))
          .where('id', '=', artifact.storedObjectId)
          .where('state', '=', 'committed')
          .executeTakeFirstOrThrow();
      const now = new Date();
      return view(
        await transaction
          .updateTable('catalogue_generated_artifacts')
          .set({
            status: 'ready',
            stored_object_id: artifact.storedObjectId,
            mime_type: artifact.mimeType,
            byte_size: artifact.byteSize,
            dimensions: artifact.dimensions ?? null,
            summary: artifact.summary ?? null,
            completed_at: now,
            updated_at: now,
          })
          .where('id', '=', artifactId)
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
    });
  }

  /** Publishes every output from one generator invocation in a single database transaction. */
  async readyBatch(
    ownerId: string,
    artifacts: readonly ReadyArtifactBatchItem[],
  ): Promise<readonly ArtifactView[]> {
    if (artifacts.length === 0) throw new TypeError('At least one ready artifact is required.');
    if (new Set(artifacts.map((artifact) => artifact.artifactId)).size !== artifacts.length)
      throw new TypeError('Ready artifact identifiers must be unique.');
    return this.database.transaction().execute(async (transaction) => {
      const ids = artifacts.map((artifact) => artifact.artifactId);
      const rows = await transaction
        .selectFrom('catalogue_generated_artifacts')
        .selectAll()
        .where('id', 'in', ids)
        .where('owner_id', '=', ownerId)
        .forUpdate()
        .execute();
      if (rows.length !== artifacts.length) throw new Error('A preview artifact is missing.');
      const byId = new Map(rows.map((row) => [row.id, row]));
      const completed: ArtifactView[] = [];
      for (const artifact of artifacts) {
        if (!Number.isSafeInteger(artifact.byteSize) || artifact.byteSize < 0)
          throw new RangeError('Artifact byte size is invalid.');
        const current = byId.get(artifact.artifactId);
        if (!current) throw new Error('A preview artifact is missing.');
        if (current.status === 'ready') {
          if (current.stored_object_id !== artifact.storedObjectId)
            throw new Error('A ready artifact cannot be replaced by a retry.');
          completed.push(view(current));
          continue;
        }
        if (current.status !== 'processing') throw new Error('Artifact is not being processed.');
        await transaction
          .insertInto('stored_objects')
          .values({
            id: artifact.storedObjectId,
            backend: artifact.backend,
            object_key: artifact.objectKey,
            checksum: artifact.checksum,
            byte_size: artifact.byteSize,
            state: 'committed',
            reference_count: 1,
            delete_after: null,
            deletion_error: null,
            created_at: new Date(),
            updated_at: new Date(),
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('stored_object_references')
          .values({
            stored_object_id: artifact.storedObjectId,
            owner_type: 'catalogue_generated_artifact',
            owner_id: artifact.artifactId,
            created_at: new Date(),
          })
          .executeTakeFirstOrThrow();
        const now = new Date();
        completed.push(
          view(
            await transaction
              .updateTable('catalogue_generated_artifacts')
              .set({
                status: 'ready',
                stored_object_id: artifact.storedObjectId,
                mime_type: artifact.mimeType,
                byte_size: artifact.byteSize,
                dimensions: artifact.dimensions ?? null,
                summary: artifact.summary ?? null,
                completed_at: now,
                updated_at: now,
              })
              .where('id', '=', artifact.artifactId)
              .returningAll()
              .executeTakeFirstOrThrow(),
          ),
        );
      }
      return completed;
    });
  }

  async finishWithoutArtifact(
    ownerId: string,
    artifactId: string,
    completion: {
      readonly status: 'failed' | 'unsupported';
      readonly code: string;
      readonly message: string;
    },
  ): Promise<ArtifactView> {
    const safe = sanitizedCompletion(completion);
    if (safe.status === 'ready') throw new Error('A ready completion requires an artifact.');
    const now = new Date();
    const row = await this.database
      .updateTable('catalogue_generated_artifacts')
      .set({
        status: safe.status,
        stored_object_id: null,
        mime_type: null,
        byte_size: null,
        failure_code: safe.code,
        failure_message: safe.message,
        completed_at: now,
        updated_at: now,
      })
      .where('id', '=', artifactId)
      .where('owner_id', '=', ownerId)
      .where('status', 'in', ['queued', 'processing'])
      .returningAll()
      .executeTakeFirstOrThrow();
    return view(row);
  }

  async forAsset(ownerId: string, sourceAssetId: string): Promise<readonly ArtifactView[]> {
    const rows = await this.database
      .selectFrom('catalogue_generated_artifacts')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('source_asset_id', '=', sourceAssetId)
      .orderBy('kind')
      .execute();
    return rows.map(view);
  }
}

function view(row: Row): ArtifactView {
  const byteSize = row.byte_size === null ? null : Number(row.byte_size);
  if (byteSize !== null && (!Number.isSafeInteger(byteSize) || byteSize < 0))
    throw new Error('Stored artifact byte size is invalid.');
  return {
    id: row.id,
    sourceAssetId: row.source_asset_id,
    kind: row.kind,
    generator: row.generator,
    generatorVersion: row.generator_version,
    status: row.status,
    storedObjectId: row.stored_object_id,
    mimeType: row.mime_type,
    byteSize,
    dimensions: row.dimensions,
    summary: row.summary,
    failure:
      row.failure_code && row.failure_message
        ? { code: row.failure_code, message: row.failure_message }
        : null,
    attempt: row.attempt,
  };
}
