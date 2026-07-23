import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { SupervisorPreviewGenerator } from '../../../src/catalogue/previews/index.js';
import type { ProcessorSupervisorClient } from '../../../src/platform/processor/supervisor/index.js';

describe('supervisor preview adapter', () => {
  it('maps compact processor metadata and checksummed outputs to artifact streams', async () => {
    const cleanup = vi.fn(async () => {});
    const execute = vi.fn(async () => ({
      processorResult: {
        status: 'ready',
        kind: 'geometry',
        dimensions: { width: 10, depth: 20, height: 30, unit: 'mm' },
        triangleCount: 12,
      },
      outputs: [
        output('preview.glb', 'model/gltf-binary', 'glb'),
        output('thumbnail.svg', 'image/svg+xml', 'svg'),
      ],
      cleanup,
    }));
    const generator = new SupervisorPreviewGenerator({
      execute,
    } as unknown as ProcessorSupervisorClient);

    const result = await generator.generate({
      format: 'stl',
      filename: 'cube.stl',
      size: 5,
      open: async () => Readable.from([Buffer.from('solid')]),
    });

    expect(result).toMatchObject({
      status: 'ready',
      files: [
        {
          kind: 'geometry_preview',
          dimensions: { width: 10, depth: 20, height: 30, unit: 'mm' },
          summary: { triangleCount: 12 },
        },
        { kind: 'thumbnail' },
      ],
    });
    await result.cleanup?.();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

function output(name: string, mimeType: string, bytes: string) {
  return {
    name,
    mimeType,
    byteSize: bytes.length,
    checksum: 'a'.repeat(64),
    open: () => Readable.from([Buffer.from(bytes)]),
  };
}
