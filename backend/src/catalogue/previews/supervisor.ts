import { randomUUID } from 'node:crypto';

import type {
  ProcessorSupervisorClient,
  SupervisorOutput,
} from '../../platform/processor/supervisor/index.js';
import type {
  GeneratedArtifactKind,
  GeneratedPreviewFile,
  PreviewGenerationResult,
} from './contracts.js';
import type { PreviewGenerator } from './operations.js';

export interface SupervisorPreviewGeneratorOptions {
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumTriangles: number;
  readonly maximumLayers: number;
  readonly maximumSegments: number;
}

export const defaultSupervisorPreviewGeneratorOptions: SupervisorPreviewGeneratorOptions = {
  maximumInputBytes: 100 * 1024 * 1024,
  maximumOutputBytes: 50 * 1024 * 1024,
  maximumTriangles: 500_000,
  maximumLayers: 5_000,
  maximumSegments: 1_000_000,
};

export class SupervisorPreviewGenerator implements PreviewGenerator {
  public constructor(
    private readonly client: ProcessorSupervisorClient,
    private readonly limits: SupervisorPreviewGeneratorOptions = defaultSupervisorPreviewGeneratorOptions,
  ) {}

  public async generate(input: {
    readonly format: 'stl' | '3mf' | 'obj' | 'step' | 'gcode';
    readonly filename: string;
    readonly size: number;
    readonly open: () => Promise<NodeJS.ReadableStream & AsyncIterable<Uint8Array>>;
  }): Promise<PreviewGenerationResult> {
    const execution = await this.client.execute({
      requestId: `preview:${randomUUID()}`,
      operation: 'generate-preview',
      inputBytes: input.size,
      input: await input.open(),
      format: input.format,
      limits: { ...this.limits },
    });
    try {
      const result = record(execution.processorResult);
      if (result.status === 'unsupported' || result.status === 'failed') {
        return {
          status: result.status,
          code: result.status === 'unsupported' ? 'preview_unsupported' : 'preview_failed',
          message: boundedReason(result.reason),
          cleanup: execution.cleanup,
        };
      }
      if (result.status !== 'ready') throw new TypeError('Preview processor result is invalid');
      const dimensions = optionalMetadata(result.dimensions);
      const summary = summaryFrom(result);
      const files = execution.outputs.map((output) => previewFile(output, dimensions, summary));
      if (files.length === 0) throw new TypeError('Preview processor returned no artifacts');
      return { status: 'ready', files, cleanup: execution.cleanup };
    } catch (error) {
      await execution.cleanup();
      throw error;
    }
  }
}

function previewFile(
  output: SupervisorOutput,
  dimensions: Readonly<Record<string, number | string>> | undefined,
  summary: Readonly<Record<string, number | string>> | undefined,
): GeneratedPreviewFile {
  const kind = artifactKind(output);
  return {
    kind,
    mimeType: output.mimeType ?? mimeTypeFor(kind),
    bytes: output.open(),
    ...(kind === 'geometry_preview' && dimensions ? { dimensions } : {}),
    ...(kind !== 'thumbnail' && summary ? { summary } : {}),
  };
}

function artifactKind(output: SupervisorOutput): GeneratedArtifactKind {
  if (output.name === 'preview.glb' && output.mimeType === 'model/gltf-binary')
    return 'geometry_preview';
  if (output.name === 'thumbnail.svg' && output.mimeType === 'image/svg+xml') return 'thumbnail';
  if (output.name === 'layers.json' && output.mimeType === 'application/vnd.yuki.toolpath+json')
    return 'toolpath_preview';
  throw new TypeError('Preview processor returned an unknown artifact');
}

function summaryFrom(
  result: Record<string, unknown>,
): Readonly<Record<string, number | string>> | undefined {
  const summary: Record<string, number> = {};
  for (const key of ['triangleCount', 'layerCount', 'segmentCount'] as const) {
    const value = result[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || Number(value) < 0)
        throw new TypeError('Preview summary is invalid');
      summary[key] = Number(value);
    }
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function optionalMetadata(value: unknown): Readonly<Record<string, number | string>> | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  const result: Record<string, number | string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (
      !/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) ||
      !(
        (typeof item === 'number' && Number.isFinite(item)) ||
        (typeof item === 'string' && item.length <= 64)
      )
    )
      throw new TypeError('Preview metadata is invalid');
    result[key] = item;
  }
  return result;
}

function boundedReason(value: unknown): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 500)
    : 'Preview unavailable.';
}

function mimeTypeFor(kind: GeneratedArtifactKind): string {
  if (kind === 'geometry_preview') return 'model/gltf-binary';
  if (kind === 'thumbnail') return 'image/svg+xml';
  return 'application/vnd.yuki.toolpath+json';
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Preview processor result is invalid');
  return value as Record<string, unknown>;
}
