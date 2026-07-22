export type DetectedAssetFormat =
  | 'stl'
  | '3mf'
  | 'obj'
  | 'step'
  | 'gcode'
  | 'image'
  | 'document'
  | 'archive'
  | 'other';

export interface DetectionLimits {
  /** Maximum bytes read for signatures and text metadata. */
  readonly maximumInspectionBytes: number;
  /** Maximum triangles for which STL coordinates are inspected. */
  readonly maximumStlTriangles: number;
  /** Maximum ZIP central-directory entries inspected. */
  readonly maximumZipEntries: number;
}

export interface RandomAccessInput {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface AssetDimensions {
  readonly width: number;
  readonly height: number;
}

export interface GeometryBounds {
  readonly minimum: readonly [number, number, number];
  readonly maximum: readonly [number, number, number];
}

export interface DetectionWarning {
  readonly code: 'filename_mismatch' | 'metadata_truncated';
  readonly message: string;
}

export interface DetectionResult {
  readonly format: DetectedAssetFormat;
  readonly mimeType: string;
  readonly confidence: 'signature' | 'structure' | 'text' | 'unknown';
  readonly metadata: {
    readonly byteSize: number;
    readonly imageDimensions?: AssetDimensions;
    readonly triangleCount?: number;
    readonly geometryBounds?: GeometryBounds;
    readonly gcodeCommandCount?: number;
    readonly lineCount?: number;
    readonly zipEntryCount?: number;
  };
  readonly warnings: readonly DetectionWarning[];
}

export class DetectionLimitError extends Error {
  override readonly name = 'DetectionLimitError';
  readonly retryable = false;
}
