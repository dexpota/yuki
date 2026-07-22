import { describe, expect, it } from 'vitest';
import { parseGcodeFacts } from '../../../../processor/src/gcode/index.js';
import {
  createGcodeFactsSnapshot,
  parseProcessorGcodeFacts,
} from '../../../src/printing/gcode/index.js';

const unknown = { status: 'unknown', reason: 'not-found' };
const evidence = [{ source: 'comment', line: 2, key: 'flavor' }];
const facts = {
  schemaVersion: 1,
  parser: { name: 'yuki-gcode', version: '1.0.0' },
  buildBounds: {
    status: 'known',
    value: {
      minimum: { x: 0, y: 5, z: 0.2 },
      maximum: { x: 100, y: 55, z: 10.2 },
      size: { width: 100, depth: 50, height: 10 },
      unit: 'mm',
    },
    evidence: [{ source: 'command', line: 6, key: 'linear-endpoint-bounds' }],
  },
  targetPrinter: unknown,
  flavor: { status: 'known', value: 'marlin2', evidence },
  nozzleDiametersMm: unknown,
  extruderCount: unknown,
  slicer: unknown,
  statistics: { linesRead: 20, movementSegments: 10 },
};

describe('G-code compatibility fact boundary', () => {
  it('accepts the real processor output without changing its facts', () => {
    const processorFacts = parseGcodeFacts(
      new TextEncoder().encode('; FLAVOR:Marlin\nT1\nG90\nG1 X0 Y0 Z0.2\nG1 X10 Y20 Z1\n'),
      {
        maximumInputBytes: 1_000,
        maximumLines: 20,
        maximumLineBytes: 100,
        maximumSegments: 10,
        maximumMetadataEntries: 10,
      },
    );
    expect(parseProcessorGcodeFacts(processorFacts)).toEqual(processorFacts);
  });

  it('validates processor facts and creates a deeply immutable asset snapshot', () => {
    const snapshot = createGcodeFactsSnapshot({
      assetId: 'asset-1',
      assetSha256: 'ab'.repeat(32),
      capturedAt: new Date('2026-07-22T10:00:00.000Z'),
      facts,
    });
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      assetId: 'asset-1',
      capturedAt: '2026-07-22T10:00:00.000Z',
      facts: { flavor: { status: 'known', value: 'marlin2' } },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.facts.buildBounds)).toBe(true);
  });

  it.each([
    [{ ...facts, schemaVersion: 2 }],
    [{ ...facts, statistics: { linesRead: Number.POSITIVE_INFINITY, movementSegments: 1 } }],
    [
      {
        ...facts,
        flavor: { status: 'known', value: 'marlin', evidence: [{ ...evidence[0], line: 0 }] },
      },
    ],
    [
      {
        ...facts,
        buildBounds: {
          ...facts.buildBounds,
          value: { ...facts.buildBounds.value, size: { width: 99, depth: 50, height: 10 } },
        },
      },
    ],
  ])('rejects malformed or non-finite processor output', (input) => {
    expect(() => parseProcessorGcodeFacts(input)).toThrow(TypeError);
  });

  it('requires a valid immutable asset identity', () => {
    expect(() =>
      createGcodeFactsSnapshot({
        assetId: 'asset-1',
        assetSha256: 'not-a-checksum',
        capturedAt: new Date('invalid'),
        facts,
      }),
    ).toThrow(TypeError);
  });
});
