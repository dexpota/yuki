import type {
  AssetDimensions,
  DetectedAssetFormat,
  DetectionLimits,
  DetectionResult,
  DetectionWarning,
  GeometryBounds,
  RandomAccessInput,
} from './types.js';
import { DetectionLimitError } from './types.js';

export const DEFAULT_DETECTION_LIMITS: DetectionLimits = {
  maximumInspectionBytes: 2 * 1024 * 1024,
  maximumStlTriangles: 200_000,
  maximumZipEntries: 10_000,
};

const extensionFormats: Readonly<Record<string, DetectedAssetFormat>> = {
  stl: 'stl',
  '3mf': '3mf',
  obj: 'obj',
  step: 'step',
  stp: 'step',
  gcode: 'gcode',
  gco: 'gcode',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  pdf: 'document',
  txt: 'document',
  md: 'document',
  zip: 'archive',
};

export async function detectAsset(
  input: RandomAccessInput,
  filename: string,
  limits: DetectionLimits = DEFAULT_DETECTION_LIMITS,
): Promise<DetectionResult> {
  validateInput(input, limits);
  const inspectionLength = Math.min(input.size, limits.maximumInspectionBytes);
  const bytes = await input.read(0, inspectionLength);
  if (bytes.byteLength > inspectionLength)
    throw new Error('Input returned more bytes than requested.');

  const detected = await detectContent(input, bytes, limits);
  const warnings: DetectionWarning[] = [];
  const expected = extensionFormats[fileExtension(filename)];
  if (expected !== undefined && detected.format !== 'other' && expected !== detected.format) {
    warnings.push({
      code: 'filename_mismatch',
      message: 'The filename extension does not match the detected file content.',
    });
  }
  if (input.size > bytes.byteLength && detected.confidence === 'text') {
    warnings.push({
      code: 'metadata_truncated',
      message: 'Metadata was derived from a bounded prefix of the file.',
    });
  }
  return { ...detected, warnings };
}

async function detectContent(
  input: RandomAccessInput,
  bytes: Uint8Array,
  limits: DetectionLimits,
): Promise<Omit<DetectionResult, 'warnings'>> {
  const byteSize = input.size;
  const png = pngDimensions(bytes);
  if (png) return imageResult('image/png', byteSize, png);
  const gif = gifDimensions(bytes);
  if (gif) return imageResult('image/gif', byteSize, gif);
  const jpeg = jpegDimensions(bytes);
  if (jpeg || startsWith(bytes, [0xff, 0xd8])) return imageResult('image/jpeg', byteSize, jpeg);
  const webp = webpDimensions(bytes);
  if (webp || (ascii(bytes.subarray(0, 4)) === 'RIFF' && ascii(bytes.subarray(8, 12)) === 'WEBP'))
    return imageResult('image/webp', byteSize, webp);

  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return baseResult('document', 'application/pdf', 'signature', byteSize);
  }
  if (isZip(bytes)) return detectZip(input, bytes, limits);

  const binaryStl = binaryStlMetadata(bytes, byteSize, limits.maximumStlTriangles);
  if (binaryStl) {
    return {
      ...baseResult('stl', 'model/stl', 'structure', byteSize),
      metadata: {
        byteSize,
        triangleCount: binaryStl.triangleCount,
        ...(binaryStl.bounds ? { geometryBounds: binaryStl.bounds } : {}),
      },
    };
  }

  const text = decodeTextPrefix(bytes);
  if (text !== undefined) {
    const asciiStl = asciiStlMetadata(text);
    if (asciiStl) {
      return {
        ...baseResult('stl', 'model/stl', 'text', byteSize),
        metadata: {
          byteSize,
          triangleCount: asciiStl.triangleCount,
          ...(asciiStl.bounds ? { geometryBounds: asciiStl.bounds } : {}),
        },
      };
    }
    if (/^\s*ISO-10303-21\s*;/i.test(text) && /\bHEADER\s*;/i.test(text)) {
      return baseResult('step', 'model/step', 'text', byteSize);
    }
    if (looksLikeObj(text)) return baseResult('obj', 'model/obj', 'text', byteSize);
    const gcode = gcodeFacts(text);
    if (gcode) {
      return {
        ...baseResult('gcode', 'text/x.gcode', 'text', byteSize),
        metadata: { byteSize, lineCount: gcode.lines, gcodeCommandCount: gcode.commands },
      };
    }
    if (looksLikeDocument(text)) return baseResult('document', 'text/plain', 'text', byteSize);
  }
  return baseResult('other', 'application/octet-stream', 'unknown', byteSize);
}

async function detectZip(
  input: RandomAccessInput,
  prefix: Uint8Array,
  limits: DetectionLimits,
): Promise<Omit<DetectionResult, 'warnings'>> {
  const tailLength = Math.min(input.size, 65_557);
  const tail =
    input.size <= prefix.byteLength
      ? prefix.subarray(prefix.byteLength - tailLength)
      : await input.read(input.size - tailLength, tailLength);
  const entries = parseZipCentralDirectory(tail, limits.maximumZipEntries);
  const normalized = entries.names.map((name) => name.replaceAll('\\', '/').toLowerCase());
  const is3mf =
    normalized.includes('[content_types].xml') &&
    normalized.some((name) => /^3d\/[^/]+\.model$/.test(name));
  const officeDocument =
    normalized.includes('[content_types].xml') &&
    normalized.some((name) => /^(word\/document|ppt\/presentation|xl\/workbook)\.xml$/.test(name));
  return {
    ...baseResult(
      is3mf ? '3mf' : officeDocument ? 'document' : 'archive',
      is3mf
        ? 'model/3mf'
        : officeDocument
          ? 'application/vnd.openxmlformats-officedocument'
          : 'application/zip',
      'structure',
      input.size,
    ),
    metadata: { byteSize: input.size, zipEntryCount: entries.count },
  };
}

function parseZipCentralDirectory(
  tail: Uint8Array,
  maximumEntries: number,
): { readonly count: number; readonly names: readonly string[] } {
  let eocd = -1;
  for (
    let index = tail.byteLength - 22;
    index >= Math.max(0, tail.byteLength - 65_557);
    index -= 1
  ) {
    if (readU32(tail, index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > tail.byteLength) {
    throw new DetectionLimitError('ZIP central directory is missing or truncated.');
  }
  const count = readU16(tail, eocd + 10);
  const directorySize = readU32(tail, eocd + 12);
  if (count > maximumEntries)
    throw new DetectionLimitError('ZIP contains too many entries to inspect.');
  if (directorySize > tail.byteLength) {
    // A large valid central directory needs archive inspection (M02), not an unbounded detection read.
    return { count, names: [] };
  }
  const start = eocd - directorySize;
  if (start < 0) return { count, names: [] };
  const names: string[] = [];
  let cursor = start;
  for (let entry = 0; entry < count; entry += 1) {
    if (cursor + 46 > eocd || readU32(tail, cursor) !== 0x02014b50) {
      throw new DetectionLimitError('ZIP central directory is malformed.');
    }
    const nameLength = readU16(tail, cursor + 28);
    const extraLength = readU16(tail, cursor + 30);
    const commentLength = readU16(tail, cursor + 32);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd) throw new DetectionLimitError('ZIP central directory is truncated.');
    names.push(
      new TextDecoder('utf-8', { fatal: false }).decode(
        tail.subarray(cursor + 46, cursor + 46 + nameLength),
      ),
    );
    cursor = end;
  }
  return { count, names };
}

function binaryStlMetadata(bytes: Uint8Array, size: number, maxTriangles: number) {
  if (bytes.byteLength < 84) return undefined;
  const triangleCount = readU32(bytes, 80);
  const expectedSize = 84 + triangleCount * 50;
  if (!Number.isSafeInteger(expectedSize) || expectedSize !== size) return undefined;
  if (triangleCount > maxTriangles || bytes.byteLength < expectedSize) {
    return { triangleCount, bounds: undefined };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[][] = [];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const base = 84 + triangle * 50 + 12;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const point = [0, 1, 2].map((axis) => view.getFloat32(base + vertex * 12 + axis * 4, true));
      if (!point.every(Number.isFinite))
        throw new DetectionLimitError('STL contains invalid coordinates.');
      values.push(point);
    }
  }
  return { triangleCount, bounds: boundsFromPoints(values) };
}

function asciiStlMetadata(text: string) {
  if (!/^\s*solid(?:\s|$)/i.test(text) || !/\bfacet\s+normal\b/i.test(text)) return undefined;
  const vertices = [...text.matchAll(/\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/gi)].map(
    (match) => [Number(match[1]), Number(match[2]), Number(match[3])],
  );
  if (vertices.some((point) => !point.every(Number.isFinite)))
    throw new DetectionLimitError('STL contains invalid coordinates.');
  return {
    triangleCount: Math.floor(vertices.length / 3),
    bounds: vertices.length ? boundsFromPoints(vertices) : undefined,
  };
}

function boundsFromPoints(points: readonly number[][]): GeometryBounds | undefined {
  if (points.length === 0) return undefined;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const point of points)
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis] ?? Infinity, point[axis] ?? Infinity);
      maximum[axis] = Math.max(maximum[axis] ?? -Infinity, point[axis] ?? -Infinity);
    }
  return {
    minimum: minimum as [number, number, number],
    maximum: maximum as [number, number, number],
  };
}

function gcodeFacts(text: string) {
  const lines = text.split(/\r?\n/);
  let commands = 0;
  for (const line of lines) if (/^\s*(?:N\d+\s+)?[GMT]\d+(?:\s|$)/i.test(line)) commands += 1;
  return commands > 0 ? { lines: lines.length, commands } : undefined;
}

function looksLikeObj(text: string): boolean {
  return (
    /(?:^|\n)\s*v\s+[-+\d.]+\s+[-+\d.]+\s+[-+\d.]+/m.test(text) &&
    /(?:^|\n)\s*f\s+\d+(?:\/\S*)?\s+\d+/m.test(text)
  );
}

function looksLikeDocument(text: string): boolean {
  if (text.length === 0) return false;
  let printable = 0;
  for (const character of text)
    if (character === '\n' || character === '\r' || character === '\t' || character >= ' ')
      printable += 1;
  return printable / text.length > 0.95;
}

function decodeTextPrefix(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function pngDimensions(bytes: Uint8Array): AssetDimensions | undefined {
  if (
    !startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    bytes.byteLength < 24 ||
    ascii(bytes.subarray(12, 16)) !== 'IHDR'
  )
    return undefined;
  return validDimensions(readU32Big(bytes, 16), readU32Big(bytes, 20));
}
function gifDimensions(bytes: Uint8Array): AssetDimensions | undefined {
  const header = ascii(bytes.subarray(0, 6));
  return (header === 'GIF87a' || header === 'GIF89a') && bytes.byteLength >= 10
    ? validDimensions(readU16(bytes, 6), readU16(bytes, 8))
    : undefined;
}
function jpegDimensions(bytes: Uint8Array): AssetDimensions | undefined {
  if (!startsWith(bytes, [0xff, 0xd8])) return undefined;
  let offset = 2;
  while (offset + 9 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd9 || marker === 0xda) break;
    const length = readU16Big(bytes, offset + 2);
    if (length < 2 || offset + 2 + length > bytes.byteLength) break;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    )
      return validDimensions(readU16Big(bytes, offset + 7), readU16Big(bytes, offset + 5));
    offset += 2 + length;
  }
  return undefined;
}
function webpDimensions(bytes: Uint8Array): AssetDimensions | undefined {
  if (
    ascii(bytes.subarray(0, 4)) !== 'RIFF' ||
    ascii(bytes.subarray(8, 12)) !== 'WEBP' ||
    bytes.byteLength < 30
  )
    return undefined;
  const kind = ascii(bytes.subarray(12, 16));
  if (kind === 'VP8X') return validDimensions(1 + readU24(bytes, 24), 1 + readU24(bytes, 27));
  return undefined;
}

function imageResult(
  mimeType: string,
  byteSize: number,
  dimensions: AssetDimensions | undefined,
): Omit<DetectionResult, 'warnings'> {
  return {
    ...baseResult('image', mimeType, 'signature', byteSize),
    metadata: { byteSize, ...(dimensions ? { imageDimensions: dimensions } : {}) },
  };
}
function baseResult(
  format: DetectedAssetFormat,
  mimeType: string,
  confidence: DetectionResult['confidence'],
  byteSize: number,
): Omit<DetectionResult, 'warnings'> {
  return { format, mimeType, confidence, metadata: { byteSize } };
}
function validDimensions(width: number, height: number): AssetDimensions | undefined {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : undefined;
}
function validateInput(input: RandomAccessInput, limits: DetectionLimits): void {
  if (!Number.isSafeInteger(input.size) || input.size < 0)
    throw new TypeError('Input size is invalid.');
  for (const value of [
    limits.maximumInspectionBytes,
    limits.maximumStlTriangles,
    limits.maximumZipEntries,
  ])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError('Detection limits are invalid.');
}
function fileExtension(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index < 0 ? '' : filename.slice(index + 1).toLowerCase();
}
function isZip(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]);
}
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}
function ascii(bytes: Uint8Array): string {
  return new TextDecoder('ascii').decode(bytes);
}
function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}
function readU16Big(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}
function readU24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}
function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}
function readU32Big(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}
