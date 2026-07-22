import { describe, expect, it } from 'vitest';

import {
  normalizePrinterProfile,
  parseStoredPrinterProfile,
} from '../../../src/printing/printers/public.js';

describe('versioned printer profile', () => {
  it('normalizes compatibility fields into schema version 1', () => {
    const profile = normalizePrinterProfile({
      buildVolume: {
        shape: 'rectangular',
        origin: 'lowerleft',
        widthMm: 220,
        depthMm: 220,
        heightMm: 250,
      },
      compatibility: {
        gcodeFlavors: [' Marlin ', 'marlin', 'RepRap'],
        nozzleDiameterMm: 0.4,
        extruderCount: 1,
      },
    });
    expect(profile).toMatchObject({
      schemaVersion: 1,
      compatibility: { gcodeFlavors: ['marlin', 'reprap'] },
    });
    expect(parseStoredPrinterProfile(profile)).toEqual(profile);
  });

  it('rejects unsafe dimensions and unknown stored versions', () => {
    expect(() =>
      normalizePrinterProfile({
        buildVolume: {
          shape: 'rectangular',
          origin: 'lowerleft',
          widthMm: Number.POSITIVE_INFINITY,
          depthMm: 220,
          heightMm: 250,
        },
        compatibility: { gcodeFlavors: [], nozzleDiameterMm: null, extruderCount: 1 },
      }),
    ).toThrow('widthMm');
    expect(() => parseStoredPrinterProfile({ schemaVersion: 2 })).toThrow('unsupported');
  });
});
