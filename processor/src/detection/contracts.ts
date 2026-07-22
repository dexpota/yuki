import type { DetectionLimits } from './types.js';

export const detectionProcessorOperation = 'detect-file' as const;
export const detectionPayloadVersion = 1 as const;

export interface DetectFileRequest {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly operation: typeof detectionProcessorOperation;
  readonly payloadVersion: typeof detectionPayloadVersion;
  readonly inputPath: '/input/file';
  readonly filename: string;
  readonly limits: DetectionLimits;
}
