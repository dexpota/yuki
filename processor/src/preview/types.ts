export type PreviewSourceFormat = 'stl' | '3mf' | 'obj' | 'step' | 'gcode';

export interface PreviewLimits {
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumTriangles: number;
  readonly maximumLayers: number;
  readonly maximumSegments: number;
}

export interface PreviewFile {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface PreviewDimensions {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly unit: 'mm';
}

export type PreviewResult =
  | {
      readonly status: 'ready';
      readonly kind: 'geometry' | 'toolpath';
      readonly files: readonly PreviewFile[];
      readonly dimensions?: PreviewDimensions;
      readonly triangleCount?: number;
      readonly layerCount?: number;
      readonly segmentCount?: number;
    }
  | { readonly status: 'unsupported'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

export class PreviewLimitError extends Error {
  override readonly name = 'PreviewLimitError';
}
