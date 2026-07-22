import { describe, expect, it } from 'vitest';

import {
  DetectionLimitError,
  detectAsset,
  type RandomAccessInput,
} from '../../src/detection/index.js';

describe('bounded asset detection', () => {
  it('uses binary STL structure ahead of a misleading filename and extracts bounds', async () => {
    const bytes = binaryStl([
      [1, 2, 3],
      [-1, 4, 0],
      [2, -2, 5],
    ]);
    const result = await detectAsset(memoryInput(bytes), 'misleading.obj');

    expect(result).toMatchObject({
      format: 'stl',
      mimeType: 'model/stl',
      confidence: 'structure',
      metadata: {
        triangleCount: 1,
        geometryBounds: { minimum: [-1, -2, 0], maximum: [2, 4, 5] },
      },
      warnings: [{ code: 'filename_mismatch' }],
    });
  });

  it.each([
    ['part.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', 'obj'],
    ['part.step', 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;', 'step'],
    ['part.gcode', '; generated\nG28\nG1 X2 Y3\nM104 S200\n', 'gcode'],
    ['notes.txt', 'assembly instructions\nuse four screws\n', 'document'],
  ])('detects bounded text content for %s', async (filename, content, format) => {
    const result = await detectAsset(memoryInput(Buffer.from(content)), filename);
    expect(result.format).toBe(format);
    if (format === 'gcode') expect(result.metadata.gcodeCommandCount).toBe(3);
  });

  it('detects PNG dimensions from its signature without trusting its extension', async () => {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    Buffer.from('IHDR').copy(bytes, 12);
    bytes.writeUInt32BE(640, 16);
    bytes.writeUInt32BE(480, 20);
    await expect(detectAsset(memoryInput(bytes), 'photo.bin')).resolves.toMatchObject({
      format: 'image',
      mimeType: 'image/png',
      metadata: { imageDimensions: { width: 640, height: 480 } },
    });
  });

  it('classifies a bounded JPEG signature even when dimensions are unavailable', async () => {
    await expect(
      detectAsset(memoryInput(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), 'photo.dat'),
    ).resolves.toMatchObject({
      format: 'image',
      mimeType: 'image/jpeg',
      metadata: { byteSize: 4 },
    });
  });

  it('distinguishes a 3MF package from an ordinary ZIP by central-directory names', async () => {
    const threeMf = centralDirectoryZip(['[Content_Types].xml', '3D/3dmodel.model']);
    const ordinary = centralDirectoryZip(['models/part.stl']);
    await expect(detectAsset(memoryInput(threeMf), 'package.zip')).resolves.toMatchObject({
      format: '3mf',
      metadata: { zipEntryCount: 2 },
    });
    await expect(detectAsset(memoryInput(ordinary), 'package.3mf')).resolves.toMatchObject({
      format: 'archive',
      warnings: [{ code: 'filename_mismatch' }],
    });

    const office = centralDirectoryZip(['[Content_Types].xml', 'word/document.xml']);
    await expect(detectAsset(memoryInput(office), 'manual.docx')).resolves.toMatchObject({
      format: 'document',
    });
  });

  it('rejects malformed and adversarial structures with bounded terminal errors', async () => {
    const truncatedZip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    await expect(detectAsset(memoryInput(truncatedZip), 'bad.zip')).rejects.toBeInstanceOf(
      DetectionLimitError,
    );

    const oversizedStl = Buffer.alloc(84 + 50 * 50);
    oversizedStl.writeUInt32LE(50, 80);
    await expect(
      detectAsset(memoryInput(oversizedStl), 'huge.stl', {
        maximumInspectionBytes: 1_024,
        maximumStlTriangles: 10,
        maximumZipEntries: 10,
      }),
    ).resolves.toMatchObject({ format: 'stl', metadata: { triangleCount: 50 } });

    const invalidCoordinates = binaryStl([
      [Number.NaN, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    await expect(detectAsset(memoryInput(invalidCoordinates), 'bad.stl')).rejects.toThrow(
      'invalid coordinates',
    );
  });

  it('never reads beyond the configured inspection prefix for an unknown large file', async () => {
    const reads: Array<[number, number]> = [];
    const input: RandomAccessInput = {
      size: 100_000_000,
      read: async (offset, length) => {
        reads.push([offset, length]);
        return new Uint8Array(length);
      },
    };
    const result = await detectAsset(input, 'unknown.bin', {
      maximumInspectionBytes: 128,
      maximumStlTriangles: 10,
      maximumZipEntries: 10,
    });
    expect(result.format).toBe('other');
    expect(reads).toEqual([[0, 128]]);
  });
});

function memoryInput(bytes: Uint8Array): RandomAccessInput {
  return {
    size: bytes.byteLength,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  };
}

function binaryStl(points: readonly (readonly [number, number, number])[]): Buffer {
  const bytes = Buffer.alloc(84 + 50);
  bytes.writeUInt32LE(1, 80);
  points.forEach((point, vertex) => {
    point.forEach((value, axis) => {
      bytes.writeFloatLE(value, 84 + 12 + vertex * 12 + axis * 4);
    });
  });
  return bytes;
}

function centralDirectoryZip(names: readonly string[]): Buffer {
  const local = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const records = names.map((name) => {
    const encoded = Buffer.from(name);
    const record = Buffer.alloc(46 + encoded.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(encoded.length, 28);
    encoded.copy(record, 46);
    return record;
  });
  const directory = Buffer.concat(records);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, directory, eocd]);
}
