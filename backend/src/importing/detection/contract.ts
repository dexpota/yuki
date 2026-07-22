import type { DetectionFacts, FileImportWarning, ImportAssetFormat } from './report.js';

export const detectionProcessorOperation = 'detect-file' as const;
export const detectionProcessorPayloadVersion = 1 as const;

export interface DetectionProcessingLimits {
  readonly maximumInspectionBytes: number;
  readonly maximumStlTriangles: number;
  readonly maximumZipEntries: number;
}

export interface DetectionProcessorRequest {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly operation: typeof detectionProcessorOperation;
  readonly payloadVersion: typeof detectionProcessorPayloadVersion;
  readonly inputPath: '/input/file';
  readonly filename: string;
  readonly limits: DetectionProcessingLimits;
}

export interface DetectionProcessorResult extends DetectionFacts {
  readonly confidence: 'signature' | 'structure' | 'text' | 'unknown';
  readonly warnings: readonly FileImportWarning[];
}

export function detectionProcessorRequest(
  requestId: string,
  filename: string,
  limits: DetectionProcessingLimits,
): DetectionProcessorRequest {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) throw new TypeError('requestId is invalid');
  if (!filename.trim() || filename.length > 1024) throw new TypeError('filename is invalid');
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(`${name} must be a positive safe integer`);
  }
  return {
    protocolVersion: 1,
    requestId,
    operation: detectionProcessorOperation,
    payloadVersion: detectionProcessorPayloadVersion,
    inputPath: '/input/file',
    filename,
    limits,
  };
}

export function parseDetectionProcessorResult(value: unknown): DetectionProcessorResult {
  if (
    !isRecord(value) ||
    !isFormat(value.format) ||
    typeof value.mimeType !== 'string' ||
    value.mimeType.length < 1 ||
    !['signature', 'structure', 'text', 'unknown'].includes(String(value.confidence)) ||
    !isRecord(value.metadata) ||
    !Array.isArray(value.warnings)
  ) {
    throw new TypeError('Processor returned a malformed detection result');
  }
  const warnings = value.warnings.map((warning) => {
    if (
      !isRecord(warning) ||
      !['filename_mismatch', 'metadata_truncated'].includes(String(warning.code)) ||
      typeof warning.message !== 'string'
    ) {
      throw new TypeError('Processor returned a malformed detection result');
    }
    return {
      code: warning.code as 'filename_mismatch' | 'metadata_truncated',
      message: warning.message,
    };
  });
  return {
    format: value.format,
    mimeType: value.mimeType,
    confidence: value.confidence as DetectionProcessorResult['confidence'],
    metadata: value.metadata,
    warnings,
  };
}

function isFormat(value: unknown): value is ImportAssetFormat {
  return (
    typeof value === 'string' &&
    ['stl', '3mf', 'obj', 'step', 'gcode', 'image', 'document', 'archive', 'other'].includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
