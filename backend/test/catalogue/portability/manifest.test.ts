import { describe, expect, it } from 'vitest';

import {
  InvalidPortablePackageError,
  parseManifestV1,
} from '../../../src/catalogue/portability/index.js';
import { manifest, uuid } from './fixture.js';

describe('export manifest v1', () => {
  it('accepts a complete self-consistent manifest', () => {
    expect(parseManifestV1(manifest())).toEqual(manifest());
  });

  it.each([
    ['unknown fields', () => ({ ...manifest(), secret: 'must-not-cross-boundary' })],
    [
      'broken current version',
      () => ({ ...manifest(), model: { ...manifest().model, currentVersionId: uuid(9) } }),
    ],
    [
      'unreferenced assets',
      () => ({ ...manifest(), versions: [{ ...manifest().versions[0], assetIds: [uuid(8)] }] }),
    ],
    [
      'unsafe paths',
      () => ({ ...manifest(), assets: [{ ...manifest().assets[0], path: '../secret' }] }),
    ],
    ['future populated sections', () => ({ ...manifest(), printHistory: [{ credential: 'no' }] })],
  ])('rejects %s with a sanitized error', (_label, mutate) => {
    expect(() => parseManifestV1(mutate())).toThrow(InvalidPortablePackageError);
    try {
      parseManifestV1(mutate());
    } catch (error) {
      expect((error as Error).message).toBe('The export package is invalid');
      expect((error as Error).message).not.toContain('secret');
    }
  });
});
