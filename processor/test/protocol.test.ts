import { describe, expect, it } from 'vitest';

import { processMessage } from '../src/main.js';
import { type ProtocolValidationError, parseRequest } from '../src/protocol.js';

describe('processor protocol', () => {
  it('responds to a version 1 probe', async () => {
    await expect(
      processMessage('{"protocolVersion":1,"requestId":"request-1","operation":"probe"}'),
    ).resolves.toMatchObject({
      requestId: 'request-1',
      ok: true,
      result: { capabilities: ['detect-file', 'extract-zip', 'generate-preview'] },
    });
  });

  it('rejects malformed JSON without exposing parser details', async () => {
    await expect(processMessage('{secret')).resolves.toEqual({
      protocolVersion: 1,
      requestId: 'unknown',
      ok: false,
      error: {
        code: 'MALFORMED_REQUEST',
        message: 'Request is not valid processor protocol JSON.',
        retryable: false,
      },
    });
  });

  it('rejects an unsupported protocol version', () => {
    expect(() =>
      parseRequest({ protocolVersion: 2, requestId: 'request-2', operation: 'probe' }),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: 'UNSUPPORTED_PROTOCOL' }),
    );
  });

  it('rejects unknown operations', () => {
    expect(() =>
      parseRequest({ protocolVersion: 1, requestId: 'request-3', operation: 'shell' }),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({ code: 'UNSUPPORTED_OPERATION' }),
    );
  });

  it('accepts a bounded archive request using only fixed container paths', () => {
    expect(
      parseRequest({
        protocolVersion: 1,
        requestId: 'archive-1',
        operation: 'extract-zip',
        payloadVersion: 1,
        inputPath: '/input/archive.zip',
        outputDirectory: '/output/archive',
        limits: {
          maximumArchiveBytes: 10,
          maximumMembers: 10,
          maximumMemberBytes: 10,
          maximumExpandedBytes: 10,
          maximumCompressionRatio: 10,
        },
      }),
    ).toMatchObject({ operation: 'extract-zip' });
  });

  it('rejects operation-specific fields that could select arbitrary paths', () => {
    expect(() =>
      parseRequest({
        protocolVersion: 1,
        requestId: 'detect-1',
        operation: 'detect-file',
        payloadVersion: 1,
        inputPath: '/etc/passwd',
        filename: 'part.stl',
        limits: {
          maximumInspectionBytes: 10,
          maximumStlTriangles: 10,
          maximumZipEntries: 10,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_REQUEST' }));
  });

  it('accepts preview generation only through fixed container paths', () => {
    expect(
      parseRequest({
        protocolVersion: 1,
        requestId: 'preview-1',
        operation: 'generate-preview',
        payload: {
          version: 1,
          inputPath: '/input/source',
          outputDirectory: '/output/preview',
          format: 'stl',
          limits: {
            maximumInputBytes: 100,
            maximumOutputBytes: 100,
            maximumTriangles: 10,
            maximumLayers: 10,
            maximumSegments: 10,
          },
        },
      }),
    ).toMatchObject({ operation: 'generate-preview', payload: { format: 'stl' } });
  });
});
