import type {
  CreateGcodeFactsSnapshotInput,
  GcodeBuildBounds,
  GcodeCompatibilityFactsV1,
  GcodeFact,
  GcodeFactEvidence,
  GcodeFactsSnapshotV1,
} from './contracts.js';

const maximumEvidenceEntries = 1_000;

export function parseProcessorGcodeFacts(value: unknown): GcodeCompatibilityFactsV1 {
  const input = object(value, 'G-code facts');
  if (input.schemaVersion !== 1) throw new TypeError('G-code facts version is unsupported.');
  const parser = object(input.parser, 'G-code parser identity');
  if (parser.name !== 'yuki-gcode') throw new TypeError('G-code parser identity is invalid.');
  const version = boundedString(parser.version, 'G-code parser version', 32);
  const statistics = object(input.statistics, 'G-code statistics');

  return {
    schemaVersion: 1,
    parser: { name: 'yuki-gcode', version },
    buildBounds: parseFact(input.buildBounds, parseBounds),
    targetPrinter: parseFact(input.targetPrinter, (item) => boundedString(item, 'target', 128)),
    flavor: parseFact(input.flavor, (item) => boundedString(item, 'flavor', 72)),
    nozzleDiametersMm: parseFact(input.nozzleDiametersMm, parseNozzles),
    extruderCount: parseFact(input.extruderCount, (item) =>
      integer(item, 'extruder count', 1, 256),
    ),
    slicer: parseFact(input.slicer, (item) => boundedString(item, 'slicer', 128)),
    statistics: {
      linesRead: integer(statistics.linesRead, 'line count', 0, 10_000_000),
      movementSegments: integer(statistics.movementSegments, 'movement count', 0, 10_000_000),
    },
  };
}

export function createGcodeFactsSnapshot(
  input: CreateGcodeFactsSnapshotInput,
): Readonly<GcodeFactsSnapshotV1> {
  const assetId = boundedString(input.assetId, 'asset id', 128);
  if (!/^[a-f\d]{64}$/i.test(input.assetSha256))
    throw new TypeError('Asset checksum must be a SHA-256 digest.');
  if (!Number.isFinite(input.capturedAt.getTime())) throw new TypeError('Capture time is invalid.');
  return deepFreeze({
    schemaVersion: 1,
    assetId,
    assetSha256: input.assetSha256.toLowerCase(),
    capturedAt: input.capturedAt.toISOString(),
    facts: parseProcessorGcodeFacts(input.facts),
  });
}

function parseFact<T>(input: unknown, parseValue: (value: unknown) => T): GcodeFact<T> {
  const fact = object(input, 'G-code fact');
  if (fact.status === 'unknown') {
    if (!['not-found', 'ambiguous', 'incomplete'].includes(String(fact.reason)))
      throw new TypeError('Unknown G-code fact reason is invalid.');
    return { status: 'unknown', reason: fact.reason as 'not-found' | 'ambiguous' | 'incomplete' };
  }
  if (fact.status !== 'known' || !Array.isArray(fact.evidence))
    throw new TypeError('G-code fact is invalid.');
  if (fact.evidence.length < 1 || fact.evidence.length > maximumEvidenceEntries)
    throw new TypeError('G-code fact evidence count is invalid.');
  return { status: 'known', value: parseValue(fact.value), evidence: fact.evidence.map(evidence) };
}

function evidence(value: unknown): GcodeFactEvidence {
  const input = object(value, 'G-code evidence');
  if (input.source !== 'comment' && input.source !== 'command')
    throw new TypeError('G-code evidence source is invalid.');
  return {
    source: input.source,
    line: integer(input.line, 'evidence line', 1, 10_000_000),
    key: boundedString(input.key, 'evidence key', 64),
  };
}

function parseBounds(value: unknown): GcodeBuildBounds {
  const input = object(value, 'build bounds');
  if (input.unit !== 'mm') throw new TypeError('Build-bound unit is unsupported.');
  const minimum = vector(input.minimum, 'minimum');
  const maximum = vector(input.maximum, 'maximum');
  for (const axis of ['x', 'y', 'z'] as const)
    if (maximum[axis] < minimum[axis]) throw new TypeError('Build bounds are invalid.');
  const expected = {
    width: maximum.x - minimum.x,
    depth: maximum.y - minimum.y,
    height: maximum.z - minimum.z,
  };
  const supplied = object(input.size, 'build-bound size');
  for (const dimension of ['width', 'depth', 'height'] as const) {
    const value = finite(supplied[dimension], `build ${dimension}`, 0, 2_000_000);
    if (Math.abs(value - expected[dimension]) > 1e-7)
      throw new TypeError('Build-bound size is inconsistent.');
  }
  return { minimum, maximum, size: expected, unit: 'mm' };
}

function vector(value: unknown, label: string): { x: number; y: number; z: number } {
  const input = object(value, label);
  return {
    x: finite(input.x, `${label} x`, -1_000_000, 1_000_000),
    y: finite(input.y, `${label} y`, -1_000_000, 1_000_000),
    z: finite(input.z, `${label} z`, -1_000_000, 1_000_000),
  };
}

function parseNozzles(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256)
    throw new TypeError('Nozzle diameters are invalid.');
  return value.map((item) => finite(item, 'nozzle diameter', 0.01, 10));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum)
    throw new TypeError(`${label} is invalid.`);
  return value;
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)
    throw new TypeError(`${label} is invalid.`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = finite(value, label, minimum, maximum);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${label} is invalid.`);
  return parsed;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
