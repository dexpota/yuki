import type { PreviewLimits, PreviewSourceFormat } from './types.js';

export const previewOperation = 'generate-preview';
export const previewPayloadVersion = 1;
export const previewInputPath = '/input/source';
export const previewOutputDirectory = '/output/preview';

export interface GeneratePreviewRequest {
  readonly operation: typeof previewOperation;
  readonly payload: {
    readonly version: typeof previewPayloadVersion;
    readonly inputPath: typeof previewInputPath;
    readonly outputDirectory: typeof previewOutputDirectory;
    readonly format: PreviewSourceFormat;
    readonly limits: PreviewLimits;
  };
}

export interface GeneratedPreviewDescriptor {
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

export type GeneratedPreviewResult =
  | {
      readonly status: 'ready';
      readonly kind: 'geometry' | 'toolpath';
      readonly files: readonly GeneratedPreviewDescriptor[];
      readonly dimensions?: import('./types.js').PreviewDimensions;
      readonly triangleCount?: number;
      readonly layerCount?: number;
      readonly segmentCount?: number;
    }
  | { readonly status: 'unsupported' | 'failed'; readonly reason: string };
