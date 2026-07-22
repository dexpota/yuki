import { describe, expect, it } from 'vitest';

import { archiveProcessorRequest } from '../../../src/importing/archive/contract.js';
import { parseArchiveProcessorResult } from '../../../src/importing/archive/result.js';

const limits = {
  maximumArchiveBytes: 1_000_000,
  maximumMembers: 100,
  maximumMemberBytes: 500_000,
  maximumExpandedBytes: 2_000_000,
  maximumCompressionRatio: 100,
};

describe('archive processor boundary', () => {
  it('builds a versioned request with fixed container paths', () => {
    expect(archiveProcessorRequest('archive-1', limits)).toEqual({
      protocolVersion: 1,
      requestId: 'archive-1',
      operation: 'extract-zip',
      payloadVersion: 1,
      inputPath: '/input/archive.zip',
      outputDirectory: '/output/archive',
      limits,
    });
  });

  it('rejects invalid request IDs and limits', () => {
    expect(() => archiveProcessorRequest('../unsafe', limits)).toThrow('requestId is invalid');
    expect(() => archiveProcessorRequest('safe', { ...limits, maximumMembers: 0 })).toThrow(
      'maximumMembers must be a positive safe integer',
    );
  });

  it('validates successful archive results and their aggregate size', () => {
    const checksum = 'a'.repeat(64);
    expect(
      parseArchiveProcessorResult({
        members: [{ path: 'part.stl', size: 4, checksum }],
        expandedBytes: 4,
      }),
    ).toEqual({ members: [{ path: 'part.stl', size: 4, checksum }], expandedBytes: 4 });
    expect(() =>
      parseArchiveProcessorResult({
        members: [{ path: 'part', size: 4, checksum }],
        expandedBytes: 3,
      }),
    ).toThrow('inconsistent archive result');
    expect(() =>
      parseArchiveProcessorResult({
        members: [{ path: 'part', size: 4, checksum: '/secret' }],
        expandedBytes: 4,
      }),
    ).toThrow('malformed archive result');
    expect(() =>
      parseArchiveProcessorResult({
        members: [{ path: '../escape', size: 4, checksum }],
        expandedBytes: 4,
      }),
    ).toThrow('malformed archive result');
  });
});
