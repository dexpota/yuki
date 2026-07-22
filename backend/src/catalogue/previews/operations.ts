import type { Readable } from 'node:stream';

import type { Kysely } from 'kysely';

import { enqueueJob } from '../../platform/jobs/index.js';
import type { PreviewDatabaseSchema, PreviewGenerationResult } from './contracts.js';
import type { CataloguePreviewService } from './service.js';

export const previewJobType = 'catalogue.preview.generate';
export const previewPayloadVersion = 1;

export interface PreviewGenerator {
  generate(input: {
    readonly format: 'stl' | '3mf' | 'obj' | 'step' | 'gcode';
    readonly filename: string;
    readonly size: number;
    readonly open: () => Promise<Readable>;
  }): Promise<PreviewGenerationResult>;
}

export async function requestPreviewGeneration(
  database: Kysely<PreviewDatabaseSchema>,
  previews: CataloguePreviewService,
  ownerId: string,
  sourceAssetId: string,
  format: 'stl' | '3mf' | 'obj' | 'step' | 'gcode',
  generator = 'yuki-preview',
  generatorVersion = '1',
): Promise<readonly string[]> {
  const kinds =
    format === 'gcode'
      ? (['toolpath_preview'] as const)
      : (['geometry_preview', 'thumbnail'] as const);
  const artifacts = [];
  for (const kind of kinds)
    artifacts.push(
      await previews.request(ownerId, { sourceAssetId, kind, generator, generatorVersion }),
    );
  await enqueueJob(database, {
    type: previewJobType,
    payloadVersion: previewPayloadVersion,
    payload: { ownerId, sourceAssetId, artifactIds: artifacts.map((artifact) => artifact.id) },
    idempotencyKey: `${sourceAssetId}:${generator}:${generatorVersion}`,
  });
  return artifacts.map((artifact) => artifact.id);
}
