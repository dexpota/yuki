import { describe, expect, it } from 'vitest';

import { normalizeFilamentPreset } from '../../../src/printing/filaments/index.js';

describe('filament preset validation', () => {
  it('normalizes descriptive fields without adding inventory data', () => {
    expect(
      normalizeFilamentPreset({
        displayName: '  Prusament PLA — Galaxy Black ',
        material: ' PLA ',
        colorName: ' Galaxy Black ',
        colorHex: '#1F2020',
        manufacturer: ' Prusa Polymers ',
        productName: ' Prusament PLA ',
        diameterMm: 1.75,
      }),
    ).toEqual({
      displayName: 'Prusament PLA — Galaxy Black',
      material: 'PLA',
      colorName: 'Galaxy Black',
      colorHex: '1f2020',
      manufacturer: 'Prusa Polymers',
      productName: 'Prusament PLA',
      diameterMm: 1.75,
      notes: '',
    });
  });

  it('clears empty optional text and rejects invalid fields', () => {
    expect(
      normalizeFilamentPreset({
        displayName: 'Generic PLA',
        material: 'PLA',
        colorName: ' ',
      }).colorName,
    ).toBeNull();
    expect(() => normalizeFilamentPreset({ displayName: '', material: 'PLA' })).toThrow(
      'displayName',
    );
    expect(() =>
      normalizeFilamentPreset({ displayName: 'PLA', material: 'PLA', colorHex: 'black' }),
    ).toThrow('colorHex');
    expect(() =>
      normalizeFilamentPreset({ displayName: 'PLA', material: 'PLA', diameterMm: 0 }),
    ).toThrow('diameterMm');
  });
});
