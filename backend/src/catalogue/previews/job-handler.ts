import type { Kysely } from 'kysely';

import {
  claimJob,
  completeJob,
  failJob,
  type Job,
  type RetryPolicy,
  reportJobProgress,
} from '../../platform/jobs/index.js';
import type { BlobStore } from '../../platform/storage/index.js';
import type { PreviewDatabaseSchema } from './contracts.js';
import { type PreviewGenerator, previewJobType, previewPayloadVersion } from './operations.js';
import type { CataloguePreviewService } from './service.js';

export async function handlePreviewJob(
  database: Kysely<PreviewDatabaseSchema>,
  blobStore: BlobStore,
  generator: PreviewGenerator,
  previews: CataloguePreviewService,
  job: Job,
  settings: {
    readonly storageBackend: string;
    readonly retryPolicy?: RetryPolicy;
  } = { storageBackend: 'local' },
): Promise<void> {
  const retryPolicy = settings.retryPolicy ?? { baseDelayMs: 1_000, maximumDelayMs: 60_000 };
  if (
    job.type !== previewJobType ||
    job.payloadVersion !== previewPayloadVersion ||
    !job.leaseToken
  )
    throw new TypeError('Unsupported or unclaimed preview job contract.');
  const payload = parsePayload(job.payload);
  try {
    const source = await database
      .selectFrom('catalogue_assets as asset')
      .innerJoin('catalogue_models as model', 'model.id', 'asset.model_id')
      .innerJoin('stored_objects as object', 'object.id', 'asset.stored_object_id')
      .select(['asset.format', 'asset.original_filename', 'asset.byte_size', 'object.object_key'])
      .where('asset.id', '=', payload.sourceAssetId)
      .where('model.owner_id', '=', payload.ownerId)
      .executeTakeFirstOrThrow();
    if (!isPreviewFormat(source.format)) throw new TypeError('Asset format is not previewable.');
    for (const artifactId of payload.artifactIds) await previews.start(payload.ownerId, artifactId);
    await reportJobProgress(database, job.id, job.leaseToken, 20, { stage: 'generating' });
    const generated = await generator.generate({
      format: source.format,
      filename: source.original_filename,
      size: checkedSize(source.byte_size),
      open: () => blobStore.read(source.object_key),
    });
    if (generated.status !== 'ready') {
      for (const artifactId of payload.artifactIds)
        await previews.finishWithoutArtifact(payload.ownerId, artifactId, generated);
    } else {
      const byKind = new Map(generated.files.map((file) => [file.kind, file]));
      const outputs = [];
      for (let index = 0; index < payload.artifactIds.length; index += 1) {
        const artifactId = payload.artifactIds[index];
        if (!artifactId) throw new Error('Preview artifact identifier is missing.');
        const artifact = await previews
          .forAsset(payload.ownerId, payload.sourceAssetId)
          .then((items) => items.find((item) => item.id === artifactId));
        if (!artifact) throw new Error('Preview artifact disappeared.');
        const file = byKind.get(artifact.kind);
        if (!file) throw new Error('Processor omitted a required preview artifact.');
        const committed = await blobStore.commit(await blobStore.stage(file.bytes));
        const storedObjectId = crypto.randomUUID();
        outputs.push({
          artifactId,
          storedObjectId,
          backend: settings.storageBackend,
          objectKey: committed.key,
          checksum: committed.checksum,
          mimeType: file.mimeType,
          byteSize: committed.size,
          ...(file.dimensions ? { dimensions: file.dimensions } : {}),
          ...(file.summary ? { summary: file.summary } : {}),
        });
      }
      await previews.readyBatch(payload.ownerId, outputs);
    }
    await reportJobProgress(database, job.id, job.leaseToken, 95, { stage: 'published' });
    await completeJob(database, job.id, job.leaseToken);
  } catch {
    const failedJob = await failJob(
      database,
      job.id,
      job.leaseToken,
      {
        code: 'preview_generation_failed',
        message: 'Preview generation could not be completed',
        retryable: true,
      },
      retryPolicy,
    );
    if (failedJob.state === 'dead_letter') {
      for (const artifactId of payload.artifactIds) {
        const artifact = await previews
          .forAsset(payload.ownerId, payload.sourceAssetId)
          .then((items) => items.find((item) => item.id === artifactId));
        if (artifact && (artifact.status === 'queued' || artifact.status === 'processing'))
          await previews.finishWithoutArtifact(payload.ownerId, artifactId, {
            status: 'failed',
            code: 'preview_generation_failed',
            message: 'Preview generation could not be completed.',
          });
      }
    }
  }
}

export async function processNextPreviewJob(
  database: Kysely<PreviewDatabaseSchema>,
  blobStore: BlobStore,
  generator: PreviewGenerator,
  previews: CataloguePreviewService,
  options: {
    readonly workerId: string;
    readonly leaseDurationMs: number;
    readonly storageBackend?: string;
  },
): Promise<boolean> {
  const job = await claimJob(database, { ...options, types: [previewJobType] });
  if (!job) return false;
  await handlePreviewJob(database, blobStore, generator, previews, job, {
    storageBackend: options.storageBackend ?? 'local',
  });
  return true;
}

function parsePayload(value: unknown): {
  ownerId: string;
  sourceAssetId: string;
  artifactIds: readonly string[];
} {
  if (
    !value ||
    typeof value !== 'object' ||
    !('ownerId' in value) ||
    typeof value.ownerId !== 'string' ||
    !('sourceAssetId' in value) ||
    typeof value.sourceAssetId !== 'string' ||
    !('artifactIds' in value) ||
    !Array.isArray(value.artifactIds) ||
    !value.artifactIds.every((id) => typeof id === 'string')
  )
    throw new TypeError('Preview job payload is invalid.');
  return {
    ownerId: value.ownerId,
    sourceAssetId: value.sourceAssetId,
    artifactIds: value.artifactIds,
  };
}

function isPreviewFormat(value: string): value is 'stl' | '3mf' | 'obj' | 'step' | 'gcode' {
  return ['stl', '3mf', 'obj', 'step', 'gcode'].includes(value);
}

function checkedSize(value: string | number): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Asset size is invalid.');
  return size;
}
