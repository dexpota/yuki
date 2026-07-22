import { describe, expect, it } from 'vitest';

import {
  acceptedFile,
  classifyDetectionFailure,
  detectionReport,
  exactDuplicateWarning,
  failedFile,
} from '../../../src/importing/detection/index.js';

const checksum = 'a'.repeat(64);

describe('import detection reports', () => {
  it('warns on exact content while preserving logical duplicate choices', () => {
    expect(
      exactDuplicateWarning('owner-1', checksum, [
        {
          ownerId: 'owner-1',
          assetId: 'asset-1',
          modelId: 'model-1',
          originalFilename: 'old.stl',
          checksum,
        },
        {
          ownerId: 'owner-1',
          assetId: 'asset-1',
          modelId: 'model-1',
          originalFilename: 'copy.stl',
          checksum,
        },
        {
          ownerId: 'owner-1',
          assetId: 'asset-2',
          modelId: 'model-2',
          originalFilename: 'other.stl',
          checksum: 'b'.repeat(64),
        },
      ]),
    ).toEqual({
      code: 'exact_duplicate',
      message: expect.stringContaining('separate logical asset'),
      relatedAssetIds: ['asset-1'],
    });
    expect(exactDuplicateWarning('owner-1', 'b'.repeat(64), [])).toBeUndefined();
    expect(
      exactDuplicateWarning('owner-2', checksum, [
        {
          ownerId: 'owner-1',
          assetId: 'asset-1',
          modelId: 'model-1',
          originalFilename: 'old.stl',
          checksum,
        },
      ]),
    ).toBeUndefined();
  });

  it('retains unsupported content with an explicit warning', () => {
    const result = acceptedFile({
      fileId: 'file-1',
      originalFilename: 'source.bin',
      checksum,
      detection: {
        format: 'other',
        mimeType: 'application/octet-stream',
        metadata: { byteSize: 5 },
      },
    });
    expect(result.status).toBe('accepted');
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'unsupported_content' })]);
  });

  it('blocks the whole publication after one member fails without dropping successful results', () => {
    const accepted = acceptedFile({
      fileId: 'file-1',
      originalFilename: 'one.stl',
      checksum,
      detection: { format: 'stl', mimeType: 'model/stl', metadata: { triangleCount: 1 } },
    });
    const failed = failedFile({
      fileId: 'file-2',
      originalFilename: 'two.stl',
      code: 'parser\nsecret/path',
      message: 'bad\u0000\n details '.repeat(100),
      retryable: false,
    });
    const report = detectionReport([accepted, failed]);
    expect(report).toMatchObject({
      acceptedCount: 1,
      failedCount: 1,
      publishable: false,
      retryable: false,
    });
    expect(report.files).toHaveLength(2);
    expect(failed.error.code).toBe('parser_secret_path');
    expect(failed.error.message.length).toBeLessThanOrEqual(300);
    expect([...failed.error.message].every((character) => character.charCodeAt(0) >= 32)).toBe(
      true,
    );
  });

  it('marks a failed batch retryable only when every failure is transient', () => {
    const transient = failedFile({
      fileId: 'file-1',
      originalFilename: 'one.stl',
      code: 'timeout',
      message: 'Timeout',
      retryable: true,
    });
    expect(detectionReport([transient])).toMatchObject({ publishable: false, retryable: true });
    expect(detectionReport([])).toMatchObject({ publishable: false, retryable: false });
  });

  it('maps processor errors to stable retry decisions without leaking details', () => {
    expect(classifyDetectionFailure('TIMEOUT')).toMatchObject({
      code: 'processor_timeout',
      retryable: true,
    });
    expect(classifyDetectionFailure('MALFORMED_FILE')).toMatchObject({
      code: 'malformed_file',
      retryable: false,
    });
    expect(classifyDetectionFailure('/private/path parse exploded')).toEqual({
      code: 'processing_failed',
      message: 'The file could not be inspected.',
      retryable: false,
    });
  });

  it('rejects malformed checksums rather than performing an ambiguous duplicate check', () => {
    expect(() => exactDuplicateWarning('owner-1', '../asset', [])).toThrow('SHA-256');
  });
});
