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
  it('converts a binary STL into a valid GLB, dimensions, and thumbnail', async () => {
    const result = await generatePreview(
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

  it('rejects truncated and oversized STL without emitting partial output', async () => {
    await expect(generatePreview(new Uint8Array(83), 'stl', limits)).resolves.toEqual({
      status: 'failed',
      reason: 'The file is malformed or could not be previewed safely.',
    });
    await expect(
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
    ).rejects.toThrow(PreviewLimitError);
  });

  it('builds a bounded read-only G-code layer artifact', async () => {
    const result = await generatePreview(
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

  it('triangulates OBJ polygons and resolves negative indices', async () => {
    const result = await generatePreview(
      new TextEncoder().encode('v 0 0 0\nv 2 0 0\nv 2 3 4\nv 0 3 4\nf -4/-1 -3/-1 -2/-1 -1/-1\n'),
      'obj',
      limits,
    );
    expect(result).toMatchObject({
      status: 'ready',
      kind: 'geometry',
      dimensions: { width: 2, depth: 3, height: 4, unit: 'mm' },
      triangleCount: 2,
    });
  });

  it('reads a bounded 3MF model part and converts declared units to millimeters', async () => {
    const model = `<?xml version="1.0" encoding="UTF-8"?>
      <model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <resources><object id="1" type="model"><mesh>
          <vertices>
            <vertex x="0" y="0" z="0"/>
            <vertex x="2" y="0" z="0"/>
            <vertex x="0" y="3" z="4"/>
          </vertices>
          <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
        </mesh></object>
        <object id="2" type="model"><components>
          <component objectid="1" transform="1 0 0 0 1 0 0 0 1 4 0 0"/>
        </components></object></resources>
        <build><item objectid="1"/><item objectid="2"/></build>
      </model>`;
    const result = await generatePreview(storedZip('3D/3dmodel.model', model), '3mf', limits);
    expect(result).toMatchObject({
      status: 'ready',
      kind: 'geometry',
      dimensions: { width: 60, depth: 30, height: 40, unit: 'mm' },
      triangleCount: 2,
    });
  });

  it('normalizes Open Cascade STEP tessellation and enforces its triangle limit', async () => {
    const readStep = async () => ({
      success: true,
      meshes: [
        {
          attributes: { position: { array: [0, 0, 0, 2, 0, 0, 0, 3, 4] } },
          index: { array: [0, 1, 2] },
        },
      ],
    });
    const result = await generatePreview(
      new TextEncoder().encode('ISO-10303-21;'),
      'step',
      limits,
      { readStep },
    );
    expect(result).toMatchObject({
      status: 'ready',
      kind: 'geometry',
      dimensions: { width: 2, depth: 3, height: 4, unit: 'mm' },
      triangleCount: 1,
    });
    const twoTriangles = async () => ({
      success: true,
      meshes: [
        {
          attributes: { position: { array: [0, 0, 0, 2, 0, 0, 0, 3, 4] } },
          index: { array: [0, 1, 2, 0, 2, 1] },
        },
      ],
    });
    await expect(
      generatePreview(
        new Uint8Array([1]),
        'step',
        { ...limits, maximumTriangles: 1 },
        { readStep: twoTriangles },
      ),
    ).rejects.toThrow(PreviewLimitError);
  });

  it('loads the pinned Open Cascade WASM and reports malformed STEP safely', async () => {
    await expect(
      generatePreview(new TextEncoder().encode('ISO-10303-21; invalid'), 'step', limits),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'The file is malformed or could not be previewed safely.',
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

function storedZip(name: string, content: string): Uint8Array {
  const filename = Buffer.from(name);
  const bytes = Buffer.from(content);
  const checksum = crc32(bytes);
  const local = Buffer.alloc(30 + filename.length + bytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);
  bytes.copy(local, 30 + filename.length);

  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(filename.length, 28);
  filename.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
