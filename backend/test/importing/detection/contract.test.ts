import { describe, expect, it } from 'vitest';

import {
  detectionProcessorRequest,
  parseDetectionProcessorResult,
} from '../../../src/importing/detection/index.js';

const limits = {
  maximumInspectionBytes: 2_000_000,
  maximumStlTriangles: 200_000,
  maximumZipEntries: 10_000,
};

describe('detection processor boundary', () => {
  it('builds a versioned request with a fixed container input path', () => {
    expect(detectionProcessorRequest('detect-1', 'part.stl', limits)).toEqual({
      protocolVersion: 1,
      requestId: 'detect-1',
      operation: 'detect-file',
      payloadVersion: 1,
      inputPath: '/input/file',
      filename: 'part.stl',
      limits,
    });
  });

  it('validates the untrusted processor result before exposing it to importing', () => {
    expect(
      parseDetectionProcessorResult({
        format: 'stl',
        mimeType: 'model/stl',
        confidence: 'structure',
        metadata: { byteSize: 84, triangleCount: 0 },
        warnings: [],
      }),
    ).toMatchObject({ format: 'stl', confidence: 'structure' });
    expect(() =>
      parseDetectionProcessorResult({
        format: 'executable',
        mimeType: 'application/octet-stream',
        confidence: 'unknown',
        metadata: {},
        warnings: [],
      }),
    ).toThrow('malformed detection result');
  });

  it('rejects invalid filenames and non-positive limits before invoking the processor', () => {
    expect(() => detectionProcessorRequest('detect-1', '', limits)).toThrow('filename is invalid');
    expect(() =>
      detectionProcessorRequest('detect-1', 'part.stl', {
        ...limits,
        maximumInspectionBytes: 0,
      }),
    ).toThrow('maximumInspectionBytes must be a positive safe integer');
  });
});
