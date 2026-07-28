import { randomUUID } from 'node:crypto';

import type { Kysely, Transaction } from 'kysely';

import type { BlobStore, CommittedBlob, StagedBlob } from '../../platform/storage/index.js';
import type { GeneratedArtifactTable } from '../previews/contracts.js';
import type { CatalogueDatabaseSchema } from '../schema.js';
import type {
  PrintAttemptEventTable,
  PrintAttemptNoteRevisionTable,
  PrintAttemptOutcomeCorrectionTable,
  PrintAttemptPhotoTable,
} from '../../printing/history/contracts.js';
import type { PrintAttemptTable } from '../../printing/start/contracts.js';
import {
  canonicalManifestJson,
  InvalidPortablePackageError,
  parseManifestV1,
  type YukiExportManifestV1,
} from './manifest.js';
import {
  DEFAULT_PORTABLE_ZIP_LIMITS,
  type PortableZipEntry,
  type PortableZipLimits,
  readPortableZip,
  writePortableZip,
} from './zip.js';

export interface CataloguePortabilityOptions {
  readonly storageBackend: string;
  readonly limits?: PortableZipLimits;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

type PortabilityDatabaseSchema = CatalogueDatabaseSchema & {
  readonly catalogue_generated_artifacts: GeneratedArtifactTable;
  readonly print_attempts: PrintAttemptTable;
  readonly print_attempt_events: PrintAttemptEventTable;
  readonly print_attempt_outcome_corrections: PrintAttemptOutcomeCorrectionTable;
  readonly print_attempt_note_revisions: PrintAttemptNoteRevisionTable;
  readonly print_attempt_photos: PrintAttemptPhotoTable;
};

export class CataloguePortabilityService {
  readonly #limits: PortableZipLimits;
  readonly #now: () => Date;
  readonly #newId: () => string;

  public constructor(
    private readonly database: Kysely<CatalogueDatabaseSchema>,
    private readonly blobs: BlobStore,
    private readonly options: CataloguePortabilityOptions,
  ) {
    this.#limits = options.limits ?? DEFAULT_PORTABLE_ZIP_LIMITS;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
  }

  /** Produces the package lazily; database and blob reads start on iteration. */
  public exportModel(ownerId: string, modelId: string): AsyncIterable<Uint8Array> {
    return writePortableZip(this.#exportEntries(ownerId, modelId));
  }

  async *#exportEntries(ownerId: string, modelId: string): AsyncGenerator<PortableZipEntry> {
    const database = this.database as unknown as Kysely<PortabilityDatabaseSchema>;
    const model = await database
      .selectFrom('catalogue_models')
      .selectAll()
      .where('id', '=', modelId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!model) throw new CataloguePortabilityNotFoundError('Model not found');
    const [versions, assets, tags, collections] = await Promise.all([
      database
        .selectFrom('catalogue_model_versions')
        .selectAll()
        .where('model_id', '=', modelId)
        .where('published_at', 'is not', null)
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .execute(),
      database
        .selectFrom('catalogue_assets as asset')
        .innerJoin('stored_objects as object', 'object.id', 'asset.stored_object_id')
        .select([
          'asset.id',
          'asset.model_version_id',
          'asset.role',
          'asset.format',
          'asset.original_filename',
          'asset.detected_mime_type',
          'asset.byte_size',
          'asset.checksum',
          'asset.imported_at',
          'object.object_key',
        ])
        .where('asset.model_id', '=', modelId)
        .where('asset.published_at', 'is not', null)
        .orderBy('asset.model_version_id', 'asc')
        .orderBy('asset.id', 'asc')
        .execute(),
      database
        .selectFrom('catalogue_model_tags as relation')
        .innerJoin('catalogue_tags as tag', 'tag.id', 'relation.tag_id')
        .select('tag.name')
        .where('relation.model_id', '=', modelId)
        .where('relation.owner_id', '=', ownerId)
        .orderBy('tag.normalized_name', 'asc')
        .execute(),
      database
        .selectFrom('catalogue_model_collections as relation')
        .innerJoin('catalogue_collections as collection', 'collection.id', 'relation.collection_id')
        .select(['collection.name', 'collection.description'])
        .where('relation.model_id', '=', modelId)
        .where('relation.owner_id', '=', ownerId)
        .orderBy('collection.normalized_name', 'asc')
        .execute(),
    ]);
    const [generatedArtifacts, attempts, events, corrections, revisions, photos] =
      await Promise.all([
        database
          .selectFrom('catalogue_generated_artifacts as artifact')
          .innerJoin('catalogue_assets as asset', 'asset.id', 'artifact.source_asset_id')
          .innerJoin('stored_objects as object', 'object.id', 'artifact.stored_object_id')
          .select([
            'artifact.id',
            'artifact.source_asset_id',
            'artifact.kind',
            'artifact.generator',
            'artifact.generator_version',
            'artifact.mime_type',
            'artifact.byte_size',
            'artifact.dimensions',
            'artifact.summary',
            'artifact.created_at',
            'artifact.completed_at',
            'object.object_key',
            'object.checksum',
          ])
          .where('asset.model_id', '=', modelId)
          .where('artifact.owner_id', '=', ownerId)
          .where('artifact.status', '=', 'ready')
          .orderBy('artifact.source_asset_id', 'asc')
          .orderBy('artifact.id', 'asc')
          .execute(),
        database
          .selectFrom('print_attempts')
          .selectAll()
          .where('owner_id', '=', ownerId)
          .where('model_id', '=', modelId)
          .orderBy('created_at', 'asc')
          .orderBy('id', 'asc')
          .execute(),
        database
          .selectFrom('print_attempt_events as event')
          .innerJoin('print_attempts as attempt', 'attempt.id', 'event.print_attempt_id')
          .select(['event.print_attempt_id', 'event.kind', 'event.facts', 'event.recorded_at'])
          .where('attempt.owner_id', '=', ownerId)
          .where('attempt.model_id', '=', modelId)
          .orderBy('event.recorded_at', 'asc')
          .orderBy('event.id', 'asc')
          .execute(),
        database
          .selectFrom('print_attempt_outcome_corrections as correction')
          .innerJoin('print_attempts as attempt', 'attempt.id', 'correction.print_attempt_id')
          .select([
            'correction.print_attempt_id',
            'correction.previous_outcome',
            'correction.outcome',
            'correction.reason',
            'correction.corrected_at',
          ])
          .where('attempt.owner_id', '=', ownerId)
          .where('attempt.model_id', '=', modelId)
          .orderBy('correction.corrected_at', 'asc')
          .orderBy('correction.id', 'asc')
          .execute(),
        database
          .selectFrom('print_attempt_note_revisions as revision')
          .innerJoin('print_attempts as attempt', 'attempt.id', 'revision.print_attempt_id')
          .select(['revision.print_attempt_id', 'revision.notes', 'revision.created_at'])
          .where('attempt.owner_id', '=', ownerId)
          .where('attempt.model_id', '=', modelId)
          .orderBy('revision.created_at', 'asc')
          .orderBy('revision.id', 'asc')
          .execute(),
        database
          .selectFrom('print_attempt_photos as photo')
          .innerJoin('print_attempts as attempt', 'attempt.id', 'photo.print_attempt_id')
          .innerJoin('stored_objects as object', 'object.id', 'photo.stored_object_id')
          .select([
            'photo.id',
            'photo.print_attempt_id',
            'photo.original_filename',
            'photo.detected_mime_type',
            'photo.byte_size',
            'photo.checksum',
            'photo.created_at',
            'object.object_key',
          ])
          .where('attempt.owner_id', '=', ownerId)
          .where('attempt.model_id', '=', modelId)
          .orderBy('photo.print_attempt_id', 'asc')
          .orderBy('photo.created_at', 'asc')
          .orderBy('photo.id', 'asc')
          .execute(),
      ]);
    const paths = new Map(
      assets.map((asset) => [asset.id, `assets/${asset.model_version_id}/${asset.id}`]),
    );
    const manifest: YukiExportManifestV1 = {
      format: 'yuki-model-export',
      version: 1,
      model: {
        id: model.id,
        name: model.name,
        description: model.description,
        sourceUrl: model.source_url,
        creator: model.creator,
        license: model.license,
        favorite: model.favorite,
        currentVersionId: model.current_version_id,
        coverAssetId: model.cover_asset_id,
        createdAt: model.created_at.toISOString(),
        updatedAt: model.updated_at.toISOString(),
      },
      versions: versions.map((version) => ({
        id: version.id,
        label: version.label,
        changeNote: version.change_note,
        metadataSchemaVersion: version.metadata_schema_version,
        metadata: version.metadata_snapshot as Readonly<Record<string, unknown>>,
        createdAt: version.created_at.toISOString(),
        assetIds: assets
          .filter((asset) => asset.model_version_id === version.id)
          .map((asset) => asset.id),
      })),
      assets: assets.map((asset) => ({
        id: asset.id,
        versionId: asset.model_version_id,
        path: paths.get(asset.id) as string,
        role: asset.role,
        format: asset.format,
        originalFilename: asset.original_filename,
        detectedMimeType: asset.detected_mime_type,
        byteSize: byteSize(asset.byte_size),
        sha256: asset.checksum,
        importedAt: asset.imported_at.toISOString(),
      })),
      tags: tags.map((tag) => tag.name),
      collections,
      generatedArtifacts: generatedArtifacts.map((artifact) => ({
        id: artifact.id,
        sourceAssetId: artifact.source_asset_id,
        path: `generated/${artifact.source_asset_id}/${artifact.id}`,
        kind: artifact.kind,
        generator: artifact.generator,
        generatorVersion: artifact.generator_version,
        mimeType: artifact.mime_type as string,
        byteSize: byteSize(artifact.byte_size as string | number),
        sha256: artifact.checksum,
        dimensions: artifact.dimensions as Readonly<Record<string, unknown>> | null,
        summary: artifact.summary as Readonly<Record<string, unknown>> | null,
        createdAt: artifact.created_at.toISOString(),
        completedAt: (artifact.completed_at as Date).toISOString(),
      })),
      printHistory: attempts.map((attempt) => ({
        id: attempt.id,
        source: attempt.source,
        modelVersionId: attempt.model_version_id,
        assetId: attempt.asset_id,
        state: attempt.state,
        outcome: attempt.outcome,
        printerSnapshot: attempt.printer_snapshot as Readonly<Record<string, unknown>>,
        modelSnapshot: attempt.model_snapshot as Readonly<Record<string, unknown>>,
        assetSnapshot: attempt.asset_snapshot as Readonly<Record<string, unknown>>,
        compatibilitySnapshot: attempt.compatibility_snapshot as Readonly<Record<string, unknown>>,
        overrideJustification: attempt.override_justification,
        notes: attempt.notes,
        statistics: attempt.statistics as Readonly<Record<string, unknown>>,
        startedAt: attempt.started_at?.toISOString() ?? null,
        completedAt: attempt.completed_at?.toISOString() ?? null,
        createdAt: attempt.created_at.toISOString(),
        updatedAt: attempt.updated_at.toISOString(),
        events: events
          .filter((event) => event.print_attempt_id === attempt.id)
          .map((event) => ({
            kind: event.kind,
            facts: event.facts as Readonly<Record<string, unknown>>,
            recordedAt: event.recorded_at.toISOString(),
          })),
        outcomeCorrections: corrections
          .filter((correction) => correction.print_attempt_id === attempt.id)
          .map((correction) => ({
            previousOutcome: correction.previous_outcome,
            outcome: correction.outcome,
            reason: correction.reason,
            correctedAt: correction.corrected_at.toISOString(),
          })),
        noteRevisions: revisions
          .filter((revision) => revision.print_attempt_id === attempt.id)
          .map((revision) => ({
            notes: revision.notes,
            createdAt: revision.created_at.toISOString(),
          })),
        photos: photos
          .filter((photo) => photo.print_attempt_id === attempt.id)
          .map((photo) => ({
            id: photo.id,
            path: `history/${attempt.id}/photos/${photo.id}`,
            originalFilename: photo.original_filename,
            detectedMimeType: photo.detected_mime_type,
            byteSize: byteSize(photo.byte_size),
            sha256: photo.checksum,
            createdAt: photo.created_at.toISOString(),
          })),
      })),
    };
    parseManifestV1(manifest);
    const manifestBytes = Buffer.from(canonicalManifestJson(manifest));
    yield { path: 'manifest.json', size: manifestBytes.length, source: one(manifestBytes) };
    for (const asset of assets) {
      const metadata = await this.blobs.head(asset.object_key);
      if (
        !metadata ||
        metadata.checksum !== asset.checksum ||
        metadata.size !== byteSize(asset.byte_size)
      )
        throw new CataloguePortabilityIntegrityError('An original asset is missing or corrupt');
      yield {
        path: paths.get(asset.id) as string,
        size: metadata.size,
        source: await this.blobs.read(asset.object_key),
      };
    }
    for (const payload of [
      ...generatedArtifacts.map((artifact) => ({
        path: `generated/${artifact.source_asset_id}/${artifact.id}`,
        objectKey: artifact.object_key,
        checksum: artifact.checksum,
        size: byteSize(artifact.byte_size as string | number),
      })),
      ...photos.map((photo) => ({
        path: `history/${photo.print_attempt_id}/photos/${photo.id}`,
        objectKey: photo.object_key,
        checksum: photo.checksum,
        size: byteSize(photo.byte_size),
      })),
    ]) {
      const metadata = await this.blobs.head(payload.objectKey);
      if (!metadata || metadata.checksum !== payload.checksum || metadata.size !== payload.size)
        throw new CataloguePortabilityIntegrityError('A generated artifact is missing or corrupt');
      yield {
        path: payload.path,
        size: metadata.size,
        source: await this.blobs.read(payload.objectKey),
      };
    }
  }

  /** Validates and stages every byte before publishing any catalogue row. */
  public async importModel(
    ownerId: string,
    packageBytes: AsyncIterable<Uint8Array>,
    options: { readonly modelId?: string } = {},
  ): Promise<{ readonly modelId: string }> {
    let manifest: YukiExportManifestV1 | undefined;
    const staged = new Map<string, StagedBlob>();
    const committed = new Map<string, CommittedBlob>();
    try {
      await readPortableZip(
        packageBytes,
        async (entry) => {
          const chunks: Buffer[] = [];
          for await (const chunk of entry.bytes) chunks.push(Buffer.from(chunk));
          try {
            manifest = parseManifestV1(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            if (error instanceof InvalidPortablePackageError) throw error;
            throw new InvalidPortablePackageError('invalid_manifest_json');
          }
          return new Map(payloads(manifest).map((payload) => [payload.path, payload.byteSize]));
        },
        async (entry) => {
          const payload = manifest && payloads(manifest).find((item) => item.path === entry.path);
          if (!payload) throw new InvalidPortablePackageError('unexpected_zip_entry');
          const blob = await this.blobs.stage(entry.bytes);
          const digest = await entry.sha256;
          if (
            blob.size !== payload.byteSize ||
            blob.checksum !== payload.sha256 ||
            digest !== payload.sha256
          ) {
            await this.blobs.discard(blob);
            throw new InvalidPortablePackageError('asset_checksum_mismatch');
          }
          staged.set(payload.path, blob);
        },
        this.#limits,
      );
      if (!manifest) throw new InvalidPortablePackageError('missing_manifest');
      for (const payload of payloads(manifest)) {
        const blob = staged.get(payload.path);
        if (!blob) throw new InvalidPortablePackageError('missing_payload');
        committed.set(payload.path, await this.blobs.commit(blob));
      }
      const modelId = await this.#publish(ownerId, manifest, committed, options.modelId);
      return { modelId };
    } catch (error) {
      await Promise.allSettled([...staged.values()].map((blob) => this.blobs.discard(blob)));
      await Promise.allSettled([...committed.values()].map((blob) => this.blobs.delete(blob.key)));
      if (
        error instanceof InvalidPortablePackageError ||
        error instanceof CataloguePortabilityError
      )
        throw error;
      throw new CataloguePortabilityError('The export package could not be imported');
    }
  }

  async #publish(
    ownerId: string,
    manifest: YukiExportManifestV1,
    blobs: ReadonlyMap<string, CommittedBlob>,
    requestedModelId?: string,
  ): Promise<string> {
    const modelId = requestedModelId ?? this.#newId();
    const versionIds = new Map(manifest.versions.map((version) => [version.id, this.#newId()]));
    const assetIds = new Map(manifest.assets.map((asset) => [asset.id, this.#newId()]));
    const artifactIds = new Map(
      manifest.generatedArtifacts.map((artifact) => [artifact.id, this.#newId()]),
    );
    const attemptIds = new Map(manifest.printHistory.map((attempt) => [attempt.id, this.#newId()]));
    const photoIds = new Map(
      manifest.printHistory.flatMap((attempt) =>
        attempt.photos.map((photo) => [photo.id, this.#newId()] as const),
      ),
    );
    const objectIds = new Map(payloads(manifest).map((payload) => [payload.path, this.#newId()]));
    const now = this.#now();
    const database = this.database as unknown as Kysely<PortabilityDatabaseSchema>;
    await database.transaction().execute(async (transaction) => {
      for (const payload of payloads(manifest)) {
        const blob = blobs.get(payload.path);
        if (!blob) throw new Error('Committed payload mapping is incomplete');
        await transaction
          .insertInto('stored_objects')
          .values({
            id: objectIds.get(payload.path) as string,
            backend: this.options.storageBackend,
            object_key: blob.key,
            checksum: blob.checksum,
            byte_size: blob.size,
            state: 'committed',
            reference_count: 0,
            delete_after: null,
            deletion_error: null,
            created_at: now,
            updated_at: now,
          })
          .executeTakeFirstOrThrow();
      }
      await transaction
        .insertInto('catalogue_models')
        .values({
          id: modelId,
          owner_id: ownerId,
          name: manifest.model.name,
          description: manifest.model.description,
          import_source: 'yuki_export',
          source_url: manifest.model.sourceUrl,
          creator: manifest.model.creator,
          license: manifest.model.license,
          favorite: manifest.model.favorite,
          current_version_id: versionIds.get(manifest.model.currentVersionId) as string,
          cover_asset_id:
            manifest.model.coverAssetId === null
              ? null
              : (assetIds.get(manifest.model.coverAssetId) as string),
          print_count: manifest.printHistory.filter((attempt) => attempt.completedAt !== null)
            .length,
          last_printed_at: latestCompletion(manifest),
          created_at: new Date(manifest.model.createdAt),
          updated_at: new Date(manifest.model.updatedAt),
        })
        .executeTakeFirstOrThrow();
      for (const version of manifest.versions)
        await transaction
          .insertInto('catalogue_model_versions')
          .values({
            id: versionIds.get(version.id) as string,
            model_id: modelId,
            label: version.label,
            change_note: version.changeNote,
            metadata_schema_version: version.metadataSchemaVersion,
            metadata_snapshot: version.metadata,
            created_at: new Date(version.createdAt),
            published_at: null,
          })
          .executeTakeFirstOrThrow();
      for (const asset of manifest.assets) {
        const id = assetIds.get(asset.id) as string;
        const objectId = objectIds.get(asset.path) as string;
        await transaction
          .insertInto('catalogue_assets')
          .values({
            id,
            model_id: modelId,
            model_version_id: versionIds.get(asset.versionId) as string,
            stored_object_id: objectId,
            role: asset.role,
            format: asset.format,
            original_filename: asset.originalFilename,
            detected_mime_type: asset.detectedMimeType,
            byte_size: asset.byteSize,
            checksum: asset.sha256,
            imported_at: new Date(asset.importedAt),
            published_at: null,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('stored_object_references')
          .values({
            stored_object_id: objectId,
            owner_type: 'catalogue_asset',
            owner_id: id,
            created_at: now,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable('stored_objects')
          .set({ reference_count: 1, updated_at: now })
          .where('id', '=', objectId)
          .executeTakeFirstOrThrow();
      }
      for (const artifact of manifest.generatedArtifacts) {
        const id = artifactIds.get(artifact.id) as string;
        const objectId = objectIds.get(artifact.path) as string;
        await transaction
          .insertInto('catalogue_generated_artifacts')
          .values({
            id,
            owner_id: ownerId,
            source_asset_id: assetIds.get(artifact.sourceAssetId) as string,
            kind: artifact.kind,
            status: 'ready',
            generator: artifact.generator,
            generator_version: artifact.generatorVersion,
            stored_object_id: objectId,
            mime_type: artifact.mimeType,
            byte_size: artifact.byteSize,
            dimensions: artifact.dimensions,
            summary: artifact.summary,
            failure_code: null,
            failure_message: null,
            attempt: 1,
            created_at: new Date(artifact.createdAt),
            updated_at: new Date(artifact.completedAt),
            completed_at: new Date(artifact.completedAt),
          })
          .executeTakeFirstOrThrow();
        await addObjectReference(transaction, objectId, 'catalogue_generated_artifact', id, now);
      }
      for (const attempt of manifest.printHistory) {
        const attemptId = attemptIds.get(attempt.id) as string;
        await transaction
          .insertInto('print_attempts')
          .values({
            id: attemptId,
            owner_id: ownerId,
            queue_entry_id: null,
            printer_id: null,
            model_id: modelId,
            model_version_id:
              attempt.modelVersionId === null
                ? null
                : (versionIds.get(attempt.modelVersionId) as string),
            asset_id: attempt.assetId === null ? null : (assetIds.get(attempt.assetId) as string),
            state: attempt.state,
            outcome: attempt.outcome,
            printer_snapshot: attempt.printerSnapshot,
            model_snapshot: remapModelSnapshot(
              attempt.modelSnapshot,
              modelId,
              attempt.modelVersionId === null
                ? null
                : (versionIds.get(attempt.modelVersionId) as string),
            ),
            asset_snapshot: remapAssetSnapshot(
              attempt.assetSnapshot,
              attempt.assetId === null ? null : (assetIds.get(attempt.assetId) as string),
            ),
            compatibility_snapshot: attempt.compatibilitySnapshot,
            override_justification: attempt.overrideJustification,
            started_at: dateOrNull(attempt.startedAt),
            completed_at: dateOrNull(attempt.completedAt),
            created_at: new Date(attempt.createdAt),
            updated_at: new Date(attempt.updatedAt),
            source: attempt.source,
            notes: attempt.notes,
            statistics: attempt.statistics,
            creation_idempotency_key: null,
            version: 1,
          })
          .executeTakeFirstOrThrow();
        for (const event of attempt.events.filter((event) => event.kind !== 'created'))
          await transaction
            .insertInto('print_attempt_events')
            .values({
              owner_id: ownerId,
              print_attempt_id: attemptId,
              kind: event.kind,
              facts: event.facts,
              recorded_at: new Date(event.recordedAt),
            })
            .executeTakeFirstOrThrow();
        for (const correction of attempt.outcomeCorrections)
          await transaction
            .insertInto('print_attempt_outcome_corrections')
            .values({
              id: this.#newId(),
              owner_id: ownerId,
              print_attempt_id: attemptId,
              previous_outcome: correction.previousOutcome,
              outcome: correction.outcome,
              reason: correction.reason,
              idempotency_key: null,
              corrected_at: new Date(correction.correctedAt),
            })
            .executeTakeFirstOrThrow();
        for (const revision of attempt.noteRevisions)
          await transaction
            .insertInto('print_attempt_note_revisions')
            .values({
              id: this.#newId(),
              owner_id: ownerId,
              print_attempt_id: attemptId,
              notes: revision.notes,
              idempotency_key: null,
              created_at: new Date(revision.createdAt),
            })
            .executeTakeFirstOrThrow();
        for (const photo of attempt.photos) {
          const photoId = photoIds.get(photo.id) as string;
          const objectId = objectIds.get(photo.path) as string;
          await transaction
            .insertInto('print_attempt_photos')
            .values({
              id: photoId,
              owner_id: ownerId,
              print_attempt_id: attemptId,
              stored_object_id: objectId,
              original_filename: photo.originalFilename,
              detected_mime_type: photo.detectedMimeType,
              byte_size: photo.byteSize,
              checksum: photo.sha256,
              idempotency_key: null,
              created_at: new Date(photo.createdAt),
            })
            .executeTakeFirstOrThrow();
          await addObjectReference(transaction, objectId, 'print_attempt_photo', photoId, now);
        }
      }
      for (const version of manifest.versions) {
        const versionId = versionIds.get(version.id) as string;
        await transaction
          .updateTable('catalogue_assets')
          .set({ published_at: now })
          .where('model_version_id', '=', versionId)
          .execute();
        await transaction
          .updateTable('catalogue_model_versions')
          .set({ published_at: now })
          .where('id', '=', versionId)
          .executeTakeFirstOrThrow();
      }
      for (const name of manifest.tags) {
        const tag = await transaction
          .insertInto('catalogue_tags')
          .values({
            id: this.#newId(),
            owner_id: ownerId,
            name,
            normalized_name: name.trim().toLowerCase(),
            created_at: now,
          })
          .onConflict((conflict) =>
            conflict.columns(['owner_id', 'normalized_name']).doUpdateSet({ name }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('catalogue_model_tags')
          .values({ model_id: modelId, tag_id: tag.id, owner_id: ownerId, created_at: now })
          .executeTakeFirstOrThrow();
      }
      for (const item of manifest.collections) {
        const collection = await transaction
          .insertInto('catalogue_collections')
          .values({
            id: this.#newId(),
            owner_id: ownerId,
            name: item.name,
            normalized_name: item.name.trim().toLowerCase(),
            description: item.description,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict
              .columns(['owner_id', 'normalized_name'])
              .doUpdateSet({ name: item.name, description: item.description, updated_at: now }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('catalogue_model_collections')
          .values({
            model_id: modelId,
            collection_id: collection.id,
            owner_id: ownerId,
            created_at: now,
          })
          .executeTakeFirstOrThrow();
      }
    });
    return modelId;
  }
}

export class CataloguePortabilityError extends Error {
  override readonly name: string = 'CataloguePortabilityError';
}
export class CataloguePortabilityNotFoundError extends CataloguePortabilityError {
  override readonly name: string = 'CataloguePortabilityNotFoundError';
}
export class CataloguePortabilityIntegrityError extends CataloguePortabilityError {
  override readonly name: string = 'CataloguePortabilityIntegrityError';
}

async function* one(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}
function byteSize(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new CataloguePortabilityIntegrityError('Invalid asset size');
  return result;
}

function payloads(manifest: YukiExportManifestV1): readonly {
  readonly path: string;
  readonly byteSize: number;
  readonly sha256: string;
}[] {
  return [
    ...manifest.assets,
    ...manifest.generatedArtifacts,
    ...manifest.printHistory.flatMap((attempt) => attempt.photos),
  ];
}

async function addObjectReference(
  transaction: Transaction<PortabilityDatabaseSchema>,
  objectId: string,
  ownerType: string,
  ownerId: string,
  now: Date,
): Promise<void> {
  await transaction
    .insertInto('stored_object_references')
    .values({
      stored_object_id: objectId,
      owner_type: ownerType,
      owner_id: ownerId,
      created_at: now,
    })
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable('stored_objects')
    .set({ reference_count: 1, updated_at: now })
    .where('id', '=', objectId)
    .executeTakeFirstOrThrow();
}

function dateOrNull(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function remapModelSnapshot(
  snapshot: Readonly<Record<string, unknown>>,
  modelId: string,
  versionId: string | null,
): Readonly<Record<string, unknown>> {
  return {
    ...snapshot,
    id: modelId,
    ...(versionId === null ? {} : { versionId }),
  };
}

function remapAssetSnapshot(
  snapshot: Readonly<Record<string, unknown>>,
  assetId: string | null,
): Readonly<Record<string, unknown>> {
  return assetId === null ? snapshot : { ...snapshot, id: assetId };
}

function latestCompletion(manifest: YukiExportManifestV1): Date | null {
  const values = manifest.printHistory
    .map((attempt) => attempt.completedAt)
    .filter((value): value is string => value !== null)
    .sort();
  const latest = values.at(-1);
  return latest ? new Date(latest) : null;
}
