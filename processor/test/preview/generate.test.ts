import { describe, expect, it } from 'vitest';

import { generatePreview, PreviewLimitError } from '../../src/preview/index.js';

const limits = {
  maximumInputBytes: 10_000,
  maximumOutputBytes: 10_000,
  maximumTriangles: 10,
  maximumLayers: 10,
  maximumSegments: 10,
};

describe('bounded preview generation', () => {
  it('converts a binary STL into a valid GLB, dimensions, and thumbnail', () => {
    const result = generatePreview(
      binaryStl([
        [0, 0, 0],
        [2, 0, 0],
        [0, 3, 4],
      ]),
      'stl',
      limits,
    );
    expect(result).toMatchObject({
      status: 'ready',
      kind: 'geometry',
      dimensions: { width: 2, depth: 3, height: 4, unit: 'mm' },
      triangleCount: 1,
    });
    if (result.status !== 'ready') throw new Error('expected ready preview');
    const glbFile = result.files[0];
    const thumbnail = result.files[1];
    if (!glbFile || !thumbnail) throw new Error('expected GLB and thumbnail');
    const glb = glbFile.bytes;
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(glb.byteLength);
    expect(thumbnail.mimeType).toBe('image/svg+xml');
  });

  it('rejects truncated and oversized STL without emitting partial output', () => {
    expect(generatePreview(new Uint8Array(83), 'stl', limits)).toEqual({
      status: 'failed',
      reason: 'The file is malformed or could not be previewed safely.',
    });
    expect(() =>
      generatePreview(
        binaryStl(
          Array.from(
            { length: 11 },
            () =>
              [
                [0, 0, 0],
                [1, 0, 0],
                [0, 1, 0],
              ] as const,
          ).flat(),
        ),
        'stl',
        limits,
      ),
    ).toThrow(PreviewLimitError);
  });

  it('builds a bounded read-only G-code layer artifact', () => {
    const result = generatePreview(
      new TextEncoder().encode('G90\nG1 X0 Y0 Z0 E0\nG1 X2 Y0 E1\nG1 Z0.2\nG1 X2 Y3 E2\n'),
      'gcode',
      limits,
    );
    expect(result).toMatchObject({
      status: 'ready',
      kind: 'toolpath',
      layerCount: 2,
      segmentCount: 2,
    });
  });

  it('classifies formats whose isolated converters are not installed', () => {
    for (const format of ['3mf', 'obj', 'step'] as const)
      expect(generatePreview(new Uint8Array([1]), format, limits)).toMatchObject({
        status: 'unsupported',
      });
  });
});

function binaryStl(vertices: readonly (readonly [number, number, number])[]): Uint8Array {
  const triangles = vertices.length / 3;
  const bytes = Buffer.alloc(84 + triangles * 50);
  bytes.writeUInt32LE(triangles, 80);
  vertices.forEach((vertex, index) => {
    vertex.forEach((value, axis) => {
      bytes.writeFloatLE(value, 84 + Math.floor(index / 3) * 50 + 12 + (index % 3) * 12 + axis * 4);
    });
  });
  return bytes;
}
