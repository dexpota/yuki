import type { YukiExportManifestV1 } from '../../../src/catalogue/portability/index.js';

export function manifest(): YukiExportManifestV1 {
  return {
    format: 'yuki-model-export',
    version: 1,
    model: {
      id: uuid(1),
      name: 'Cube',
      description: 'A cube',
      sourceUrl: null,
      creator: 'Yuki',
      license: 'CC0',
      favorite: true,
      currentVersionId: uuid(2),
      coverAssetId: uuid(3),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    versions: [
      {
        id: uuid(2),
        label: 'v1',
        changeNote: null,
        metadataSchemaVersion: 1,
        metadata: { dimensions: [1, 1, 1] },
        createdAt: '2026-01-01T00:00:00.000Z',
        assetIds: [uuid(3)],
      },
    ],
    assets: [
      {
        id: uuid(3),
        versionId: uuid(2),
        path: `assets/${uuid(2)}/${uuid(3)}`,
        role: 'geometry',
        format: 'stl',
        originalFilename: 'cube.stl',
        detectedMimeType: 'model/stl',
        byteSize: 4,
        sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
        importedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    tags: ['Test'],
    collections: [{ name: 'Calibration', description: 'Fixtures' }],
    generatedArtifacts: [],
    printHistory: [],
  };
}

export function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
