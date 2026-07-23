import { describe, expect, it } from 'vitest';

import {
  createPrinterCompatibilitySnapshot,
  evaluateCompatibility,
} from '../../../src/printing/compatibility/index.js';
import { createGcodeFactsSnapshot } from '../../../src/printing/gcode/index.js';
import { normalizePrinterProfile } from '../../../src/printing/printers/public.js';

const absent = { status: 'unknown', reason: 'not-found' } as const;
const evidence = [{ source: 'comment', line: 1, key: 'test' }] as const;
const known = <T>(value: T) => ({ status: 'known', value, evidence }) as const;
const evaluatedAt = new Date('2026-07-23T12:00:00.000Z');

describe('G-code compatibility rule set 1.0.0', () => {
  it('produces compatible when every present fact passes', () => {
    const result = evaluate(facts());
    expect(result.result).toMatchObject({
      status: 'compatible',
      blocksByDefault: false,
      canOverride: false,
    });
    expect(result.result.checks.map((check) => check.status)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.result.checks)).toBe(true);
  });

  it.each([
    [
      'build volume',
      facts({
        buildBounds: known(bounds({ maximum: { x: 221, y: 200, z: 100 } })),
      }),
      'build_volume_exceeded',
    ],
    ['flavor', facts({ flavor: known('klipper') }), 'gcode_flavor_unsupported'],
    ['extruder count', facts({ extruderCount: known(2) }), 'extruder_count_exceeded'],
  ])('classifies a known %s conflict as hard incompatible', (_label, input, code) => {
    const result = evaluate(input).result;
    expect(result).toMatchObject({
      status: 'incompatible',
      blocksByDefault: true,
      canOverride: false,
    });
    expect(result.checks).toContainEqual(expect.objectContaining({ code, status: 'incompatible' }));
  });

  it.each([
    [
      'target printer',
      facts({ targetPrinter: known('Another printer') }),
      'target_printer_mismatch',
    ],
    ['nozzle diameter', facts({ nozzleDiametersMm: known([0.6]) }), 'nozzle_diameter_mismatch'],
  ])('classifies an advisory %s mismatch as an overridable warning', (_label, input, code) => {
    const result = evaluate(input).result;
    expect(result).toMatchObject({ status: 'warning', blocksByDefault: true, canOverride: true });
    expect(result.checks).toContainEqual(expect.objectContaining({ code, status: 'warning' }));
  });

  it('blocks unknown when known G-code facts lack printer configuration', () => {
    const result = evaluate(facts(), { nozzleDiameterMm: null }).result;
    expect(result).toMatchObject({ status: 'unknown', blocksByDefault: true, canOverride: true });
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: 'printer_nozzle_unconfigured', status: 'unknown' }),
    );
  });

  it('blocks unknown when no fact can be compared', () => {
    const result = evaluate(
      facts({
        buildBounds: absent,
        targetPrinter: absent,
        flavor: absent,
        nozzleDiametersMm: absent,
        extruderCount: absent,
      }),
    ).result;
    expect(result.status).toBe('unknown');
    expect(result.checks.every((check) => check.status === 'not_applicable')).toBe(true);
  });

  it('uses hard-incompatible precedence over warning and unknown', () => {
    const result = evaluate(
      facts({
        targetPrinter: known('Another printer'),
        flavor: known('klipper'),
        nozzleDiametersMm: known([0.4]),
      }),
      { nozzleDiameterMm: null },
    ).result;
    expect(result).toMatchObject({ status: 'incompatible', canOverride: false });
  });

  it('checks every bounds corner for a circular build volume', () => {
    const profile = normalizePrinterProfile({
      buildVolume: {
        shape: 'circular',
        widthMm: 200,
        depthMm: 200,
        heightMm: 200,
        origin: 'center',
      },
      compatibility: {
        gcodeFlavors: ['marlin'],
        nozzleDiameterMm: 0.4,
        extruderCount: 1,
      },
    });
    const printer = createPrinterCompatibilitySnapshot({
      printerId: 'printer-1',
      displayName: 'Workshop printer',
      capturedAt: evaluatedAt,
      profile,
    });
    const result = evaluateCompatibility(
      snapshot(
        facts({
          buildBounds: known(
            bounds({
              minimum: { x: -80, y: -80, z: 0 },
              maximum: { x: 80, y: 80, z: 10 },
            }),
          ),
        }),
      ),
      printer,
      evaluatedAt,
    );
    expect(result.result.status).toBe('incompatible');
  });
});

function evaluate(
  input: ReturnType<typeof facts>,
  compatibility: { readonly nozzleDiameterMm: number | null } = { nozzleDiameterMm: 0.4 },
) {
  const profile = normalizePrinterProfile({
    buildVolume: {
      shape: 'rectangular',
      widthMm: 220,
      depthMm: 220,
      heightMm: 250,
      origin: 'lowerleft',
    },
    compatibility: {
      gcodeFlavors: ['marlin'],
      nozzleDiameterMm: compatibility.nozzleDiameterMm,
      extruderCount: 1,
    },
  });
  return evaluateCompatibility(
    snapshot(input),
    createPrinterCompatibilitySnapshot({
      printerId: 'printer-1',
      displayName: 'Workshop printer',
      capturedAt: evaluatedAt,
      profile,
    }),
    evaluatedAt,
  );
}

function snapshot(input: ReturnType<typeof facts>) {
  return createGcodeFactsSnapshot({
    assetId: 'asset-1',
    assetSha256: 'ab'.repeat(32),
    capturedAt: evaluatedAt,
    facts: input,
  });
}

function facts(
  changes: Partial<{
    buildBounds: ReturnType<typeof known<ReturnType<typeof bounds>>> | typeof absent;
    targetPrinter: ReturnType<typeof known<string>> | typeof absent;
    flavor: ReturnType<typeof known<string>> | typeof absent;
    nozzleDiametersMm: ReturnType<typeof known<readonly number[]>> | typeof absent;
    extruderCount: ReturnType<typeof known<number>> | typeof absent;
  }> = {},
) {
  return {
    schemaVersion: 1,
    parser: { name: 'yuki-gcode', version: '1.0.0' },
    buildBounds: known(bounds()),
    targetPrinter: known('Workshop printer'),
    flavor: known('Marlin 2'),
    nozzleDiametersMm: known([0.4]),
    extruderCount: known(1),
    slicer: absent,
    statistics: { linesRead: 20, movementSegments: 10 },
    ...changes,
  };
}

function bounds(
  changes: Partial<{
    minimum: { x: number; y: number; z: number };
    maximum: { x: number; y: number; z: number };
  }> = {},
) {
  const minimum = changes.minimum ?? { x: 0, y: 0, z: 0.2 };
  const maximum = changes.maximum ?? { x: 100, y: 100, z: 10.2 };
  return {
    minimum,
    maximum,
    size: {
      width: maximum.x - minimum.x,
      depth: maximum.y - minimum.y,
      height: maximum.z - minimum.z,
    },
    unit: 'mm' as const,
  };
}
