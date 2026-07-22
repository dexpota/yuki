import type { PreviewDimensions, PreviewLimits, PreviewResult } from './types.js';
import { PreviewLimitError } from './types.js';

export const DEFAULT_PREVIEW_LIMITS: PreviewLimits = {
  maximumInputBytes: 100 * 1024 * 1024,
  maximumOutputBytes: 50 * 1024 * 1024,
  maximumTriangles: 500_000,
  maximumLayers: 5_000,
  maximumSegments: 1_000_000,
};

export function generatePreview(
  input: Uint8Array,
  format: 'stl' | '3mf' | 'obj' | 'step' | 'gcode',
  limits: PreviewLimits = DEFAULT_PREVIEW_LIMITS,
): PreviewResult {
  validateLimits(limits);
  if (input.byteLength > limits.maximumInputBytes)
    throw new PreviewLimitError('Preview input exceeds the configured byte limit.');
  try {
    if (format === 'stl') return geometryPreview(parseStl(input, limits), limits);
    if (format === 'gcode') return gcodePreview(input, limits);
    return {
      status: 'unsupported',
      reason: `${format.toUpperCase()} preview conversion is not installed in this processor image.`,
    };
  } catch (error) {
    if (error instanceof PreviewLimitError) throw error;
    return { status: 'failed', reason: 'The file is malformed or could not be previewed safely.' };
  }
}

interface Mesh {
  readonly positions: Float32Array;
  readonly minimum: [number, number, number];
  readonly maximum: [number, number, number];
}

function parseStl(input: Uint8Array, limits: PreviewLimits): Mesh {
  if (input.byteLength >= 84) {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const count = view.getUint32(80, true);
    const expected = 84 + count * 50;
    if (Number.isSafeInteger(expected) && expected === input.byteLength)
      return parseBinaryStl(view, count, limits);
  }
  return parseAsciiStl(input, limits);
}

function parseBinaryStl(view: DataView, count: number, limits: PreviewLimits): Mesh {
  if (count === 0) throw new Error('empty STL');
  if (count > limits.maximumTriangles) throw new PreviewLimitError('STL triangle limit exceeded.');
  const positions = new Float32Array(count * 9);
  let output = 0;
  for (let triangle = 0; triangle < count; triangle += 1) {
    const vertexStart = 84 + triangle * 50 + 12;
    for (let coordinate = 0; coordinate < 9; coordinate += 1) {
      const value = view.getFloat32(vertexStart + coordinate * 4, true);
      if (!Number.isFinite(value)) throw new Error('invalid coordinate');
      positions[output++] = value;
    }
  }
  return meshWithBounds(positions);
}

function parseAsciiStl(input: Uint8Array, limits: PreviewLimits): Mesh {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  if (!/^\s*solid\b/i.test(text) || !/\bendsolid\b/i.test(text)) throw new Error('not STL');
  const values: number[] = [];
  const vertices = /^\s*vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s*$/gim;
  for (const match of text.matchAll(vertices)) {
    if (values.length / 9 >= limits.maximumTriangles)
      throw new PreviewLimitError('STL triangle limit exceeded.');
    const point = match.slice(1).map(Number);
    if (point.some((value) => !Number.isFinite(value))) throw new Error('invalid coordinate');
    values.push(...point);
  }
  if (values.length === 0 || values.length % 9 !== 0) throw new Error('invalid facets');
  return meshWithBounds(Float32Array.from(values));
}

function meshWithBounds(positions: Float32Array): Mesh {
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index];
    const y = positions[index + 1];
    const z = positions[index + 2];
    if (x === undefined || y === undefined || z === undefined) throw new Error('invalid mesh');
    minimum[0] = Math.min(minimum[0], x);
    minimum[1] = Math.min(minimum[1], y);
    minimum[2] = Math.min(minimum[2], z);
    maximum[0] = Math.max(maximum[0], x);
    maximum[1] = Math.max(maximum[1], y);
    maximum[2] = Math.max(maximum[2], z);
  }
  return { positions, minimum, maximum };
}

function geometryPreview(mesh: Mesh, limits: PreviewLimits): PreviewResult {
  const glb = encodeGlb(mesh);
  const dimensions: PreviewDimensions = {
    width: mesh.maximum[0] - mesh.minimum[0],
    depth: mesh.maximum[1] - mesh.minimum[1],
    height: mesh.maximum[2] - mesh.minimum[2],
    unit: 'mm',
  };
  const thumbnail = encodeThumbnail(mesh);
  enforceOutputLimit([glb, thumbnail], limits);
  return {
    status: 'ready',
    kind: 'geometry',
    files: [
      { name: 'preview.glb', mimeType: 'model/gltf-binary', bytes: glb },
      { name: 'thumbnail.svg', mimeType: 'image/svg+xml', bytes: thumbnail },
    ],
    dimensions,
    triangleCount: mesh.positions.length / 9,
  };
}

function encodeGlb(mesh: Mesh): Uint8Array {
  const binary = new Uint8Array(
    mesh.positions.buffer,
    mesh.positions.byteOffset,
    mesh.positions.byteLength,
  );
  const jsonValue = {
    asset: { version: '2.0', generator: 'yuki-preview-1' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.byteLength, target: 34962 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: mesh.positions.length / 3,
        type: 'VEC3',
        min: mesh.minimum,
        max: mesh.maximum,
      },
    ],
  };
  const encodedJson = new TextEncoder().encode(JSON.stringify(jsonValue));
  const jsonLength = align4(encodedJson.byteLength);
  const binaryLength = align4(binary.byteLength);
  const output = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.fill(0x20, 20, 20 + jsonLength);
  output.set(encodedJson, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binaryLength, true);
  view.setUint32(binaryHeader + 4, 0x004e4942, true);
  output.set(binary, binaryHeader + 8);
  return output;
}

function encodeThumbnail(mesh: Mesh): Uint8Array {
  const width = Math.max(mesh.maximum[0] - mesh.minimum[0], 1e-9);
  const height = Math.max(mesh.maximum[1] - mesh.minimum[1], 1e-9);
  const points: string[] = [];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const inputX = mesh.positions[index];
    const inputY = mesh.positions[index + 1];
    if (inputX === undefined || inputY === undefined) throw new Error('invalid mesh');
    const x = 16 + ((inputX - mesh.minimum[0]) / width) * 224;
    const y = 240 - ((inputY - mesh.minimum[1]) / height) * 224;
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#eef2f6"/><g fill="#54728c" stroke="#29465b" stroke-width="2">${chunk(
    points,
    3,
  )
    .map((triangle) => `<polygon points="${triangle.join(' ')}"/>`)
    .join('')}</g></svg>`;
  return new TextEncoder().encode(svg);
}

function gcodePreview(input: Uint8Array, limits: PreviewLimits): PreviewResult {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  let x = 0;
  let y = 0;
  let z = 0;
  let e = 0;
  let relative = false;
  let extruderRelative = false;
  let layer = 0;
  const layers: Array<{ z: number; segments: number[][] }> = [{ z: 0, segments: [] }];
  let segmentCount = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split(';', 1)[0]?.trim().toUpperCase() ?? '';
    if (line === 'G90') relative = false;
    if (line === 'G91') relative = true;
    if (line === 'M82') extruderRelative = false;
    if (line === 'M83') extruderRelative = true;
    if (/^G92(?:\s|$)/.test(line)) {
      x = coordinate(line, 'X', x, false);
      y = coordinate(line, 'Y', y, false);
      z = coordinate(line, 'Z', z, false);
      e = coordinate(line, 'E', e, false);
      continue;
    }
    if (!/^G(?:0|1)(?:\s|$)/.test(line)) continue;
    const nextX = coordinate(line, 'X', x, relative);
    const nextY = coordinate(line, 'Y', y, relative);
    const nextZ = coordinate(line, 'Z', z, relative);
    const nextE = coordinate(line, 'E', e, extruderRelative);
    if (nextZ !== z) {
      layer += 1;
      if (layer >= limits.maximumLayers)
        throw new PreviewLimitError('G-code layer limit exceeded.');
      layers.push({ z: nextZ, segments: [] });
    }
    if (nextE > e && (nextX !== x || nextY !== y)) {
      segmentCount += 1;
      if (segmentCount > limits.maximumSegments)
        throw new PreviewLimitError('G-code segment limit exceeded.');
      const currentLayer = layers[layer];
      if (!currentLayer) throw new Error('invalid layer');
      currentLayer.segments.push([x, y, nextX, nextY]);
    }
    x = nextX;
    y = nextY;
    z = nextZ;
    e = nextE;
  }
  if (segmentCount === 0)
    return { status: 'unsupported', reason: 'No supported extrusion moves were found.' };
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, unit: 'mm', layers }));
  enforceOutputLimit([bytes], limits);
  return {
    status: 'ready',
    kind: 'toolpath',
    files: [{ name: 'layers.json', mimeType: 'application/vnd.yuki.toolpath+json', bytes }],
    layerCount: layers.length,
    segmentCount,
  };
}

function coordinate(line: string, axis: string, current: number, relative: boolean): number {
  const match = new RegExp(`(?:^|\\s)${axis}(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))`).exec(line);
  if (!match) return current;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) throw new Error('invalid coordinate');
  return relative ? current + parsed : parsed;
}

function validateLimits(limits: PreviewLimits): void {
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError('Preview limits must be positive integers.');
}

function enforceOutputLimit(outputs: readonly Uint8Array[], limits: PreviewLimits): void {
  const total = outputs.reduce((sum, output) => sum + output.byteLength, 0);
  if (total > limits.maximumOutputBytes)
    throw new PreviewLimitError('Preview output byte limit exceeded.');
}

function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
}

function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}
