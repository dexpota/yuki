import type { Readable } from 'node:stream';

import yauzl, { type Entry, type ZipFile } from 'yauzl';

import type { PreviewLimits } from './types.js';
import { PreviewLimitError } from './types.js';

const maximumMembers = 1_000;
const maximumCompressionRatio = 100;

export async function readThreeMfMesh(
  input: Uint8Array,
  limits: PreviewLimits,
): Promise<Float32Array> {
  let zip: ZipFile | undefined;
  try {
    zip = await openArchive(input);
    const model = await findModel(zip, limits);
    if (!model) throw new Error('3MF model part is missing');
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(
      await readEntry(zip, model, limits.maximumInputBytes),
    );
    return parseModel(xml, limits);
  } finally {
    zip?.close();
  }
}

async function findModel(zip: ZipFile, limits: PreviewLimits): Promise<Entry | undefined> {
  let fallback: Entry | undefined;
  let members = 0;
  while (true) {
    const entry = await nextEntry(zip);
    if (!entry) return fallback;
    members += 1;
    if (members > maximumMembers) throw new PreviewLimitError('3MF member limit exceeded.');
    if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new Error('encrypted 3MF');
    if (
      !Number.isSafeInteger(entry.uncompressedSize) ||
      !Number.isSafeInteger(entry.compressedSize) ||
      entry.uncompressedSize > limits.maximumInputBytes
    )
      throw new PreviewLimitError('3MF model part exceeds the configured byte limit.');
    const ratio =
      entry.compressedSize === 0
        ? entry.uncompressedSize === 0
          ? 0
          : Number.POSITIVE_INFINITY
        : entry.uncompressedSize / entry.compressedSize;
    if (ratio > maximumCompressionRatio)
      throw new PreviewLimitError('3MF compression ratio limit exceeded.');
    const name = entry.fileName.toLocaleLowerCase('en-US');
    if (name === '3d/3dmodel.model') return entry;
    if (!fallback && /^3d\/[^/]+\.model$/.test(name)) fallback = entry;
  }
}

function parseModel(xml: string, limits: PreviewLimits): Float32Array {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('3MF entities are not supported');
  const model = /<(?:[\w.-]+:)?model\b([^>]*)>/i.exec(xml);
  if (!model) throw new Error('invalid 3MF model');
  const scale = unitScale(attribute(model[1] ?? '', 'unit') ?? 'millimeter');
  const objects = new Map<number, ThreeMfObject>();
  const object = /<(?:[\w.-]+:)?object\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?object\s*>/gi;
  for (const objectMatch of xml.matchAll(object)) {
    const id = integerAttribute(objectMatch[1] ?? '', 'id');
    if (objects.has(id)) throw new Error('duplicate 3MF object');
    const body = objectMatch[2] ?? '';
    const mesh = parseMesh(body, scale, limits);
    const components = parseComponents(body, scale);
    if ((mesh && components.length > 0) || (!mesh && components.length === 0))
      throw new Error('invalid 3MF object');
    objects.set(id, { mesh, components });
  }
  if (objects.size === 0) throw new Error('empty 3MF resources');

  const build = /<(?:[\w.-]+:)?build\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?build\s*>/i.exec(xml);
  if (!build) throw new Error('3MF build is missing');
  const positions: number[] = [];
  const item = /<(?:[\w.-]+:)?item\b([^>]*)\/?>/gi;
  for (const match of (build[1] ?? '').matchAll(item)) {
    appendObject(
      integerAttribute(match[1] ?? '', 'objectid'),
      [matrixAttribute(match[1] ?? '', 'transform', scale)],
      objects,
      new Set(),
      positions,
      limits,
    );
  }
  if (positions.length === 0) throw new Error('empty 3MF mesh');
  return Float32Array.from(positions);
}

type Matrix = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

interface ThreeMfObject {
  readonly mesh: Float32Array | undefined;
  readonly components: readonly { readonly objectId: number; readonly transform: Matrix }[];
}

function parseMesh(body: string, scale: number, limits: PreviewLimits): Float32Array | undefined {
  if (!/<(?:[\w.-]+:)?mesh\b/i.test(body)) return undefined;
  const vertices: Array<readonly [number, number, number]> = [];
  const vertex = /<(?:[\w.-]+:)?vertex\b([^>]*)\/?>/gi;
  for (const match of body.matchAll(vertex)) {
    if (vertices.length >= limits.maximumTriangles * 3)
      throw new PreviewLimitError('3MF vertex limit exceeded.');
    vertices.push([
      finiteAttribute(match[1] ?? '', 'x') * scale,
      finiteAttribute(match[1] ?? '', 'y') * scale,
      finiteAttribute(match[1] ?? '', 'z') * scale,
    ]);
  }
  const positions: number[] = [];
  const triangle = /<(?:[\w.-]+:)?triangle\b([^>]*)\/?>/gi;
  for (const match of body.matchAll(triangle)) {
    if (positions.length / 9 >= limits.maximumTriangles)
      throw new PreviewLimitError('3MF triangle limit exceeded.');
    for (const name of ['v1', 'v2', 'v3']) {
      const index = integerAttribute(match[1] ?? '', name);
      const point = vertices[index];
      if (!point) throw new Error('invalid 3MF vertex index');
      positions.push(...point);
    }
  }
  if (positions.length === 0) throw new Error('empty 3MF mesh object');
  return Float32Array.from(positions);
}

function parseComponents(
  body: string,
  scale: number,
): readonly { readonly objectId: number; readonly transform: Matrix }[] {
  const result: { objectId: number; transform: Matrix }[] = [];
  const component = /<(?:[\w.-]+:)?component\b([^>]*)\/?>/gi;
  for (const match of body.matchAll(component))
    result.push({
      objectId: integerAttribute(match[1] ?? '', 'objectid'),
      transform: matrixAttribute(match[1] ?? '', 'transform', scale),
    });
  return result;
}

function appendObject(
  objectId: number,
  transforms: readonly Matrix[],
  objects: ReadonlyMap<number, ThreeMfObject>,
  ancestors: ReadonlySet<number>,
  output: number[],
  limits: PreviewLimits,
): void {
  if (ancestors.has(objectId)) throw new Error('cyclic 3MF components');
  const object = objects.get(objectId);
  if (!object) throw new Error('missing 3MF object');
  if (object.mesh) {
    if (output.length / 9 + object.mesh.length / 9 > limits.maximumTriangles)
      throw new PreviewLimitError('3MF triangle limit exceeded.');
    for (let index = 0; index < object.mesh.length; index += 3) {
      let point: readonly [number, number, number] = [
        object.mesh[index] as number,
        object.mesh[index + 1] as number,
        object.mesh[index + 2] as number,
      ];
      for (const transform of transforms) point = applyMatrix(point, transform);
      output.push(...point);
    }
    return;
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(objectId);
  for (const component of object.components)
    appendObject(
      component.objectId,
      [component.transform, ...transforms],
      objects,
      nextAncestors,
      output,
      limits,
    );
}

function matrixAttribute(source: string, name: string, scale: number): Matrix {
  const raw = attribute(source, name);
  if (raw === undefined) return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const values = raw.trim().split(/\s+/).map(Number);
  if (values.length !== 12 || values.some((value) => !Number.isFinite(value)))
    throw new Error(`invalid 3MF ${name}`);
  values[9] = (values[9] as number) * scale;
  values[10] = (values[10] as number) * scale;
  values[11] = (values[11] as number) * scale;
  return values as unknown as Matrix;
}

function applyMatrix(
  point: readonly [number, number, number],
  matrix: Matrix,
): readonly [number, number, number] {
  const [x, y, z] = point;
  return [
    x * matrix[0] + y * matrix[3] + z * matrix[6] + matrix[9],
    x * matrix[1] + y * matrix[4] + z * matrix[7] + matrix[10],
    x * matrix[2] + y * matrix[5] + z * matrix[8] + matrix[11],
  ];
}

function attribute(source: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(source);
  return match?.[2];
}

function finiteAttribute(source: string, name: string): number {
  const raw = attribute(source, name);
  if (raw === undefined || raw.trim() === '') throw new Error(`invalid 3MF ${name}`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`invalid 3MF ${name}`);
  return value;
}

function integerAttribute(source: string, name: string): number {
  const value = attribute(source, name);
  if (!value || !/^\d+$/.test(value)) throw new Error(`invalid 3MF ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid 3MF ${name}`);
  return parsed;
}

function unitScale(unit: string): number {
  const scales: Readonly<Record<string, number>> = {
    micron: 0.001,
    millimeter: 1,
    centimeter: 10,
    meter: 1_000,
    inch: 25.4,
    foot: 304.8,
  };
  const scale = scales[unit.toLocaleLowerCase('en-US')];
  if (scale === undefined) throw new Error('unsupported 3MF unit');
  return scale;
}

function openArchive(input: Uint8Array): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(input.buffer, input.byteOffset, input.byteLength),
      {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error('3MF could not be opened'));
        else resolve(zip);
      },
    );
  });
}

function nextEntry(zip: ZipFile): Promise<Entry | undefined> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    };
    const onEntry = (entry: Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(undefined);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    zip.once('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    zip.readEntry();
  });
}

async function readEntry(zip: ZipFile, entry: Entry, limit: number): Promise<Uint8Array> {
  const stream = await openEntryStream(zip, entry);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) {
      stream.destroy();
      throw new PreviewLimitError('3MF model part exceeds the configured byte limit.');
    }
    chunks.push(bytes);
  }
  if (size !== entry.uncompressedSize) throw new Error('truncated 3MF model part');
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error('3MF member could not be opened'));
      else resolve(stream);
    });
  });
}
