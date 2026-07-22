import {
  type GcodeBuildBounds,
  type GcodeCompatibilityFactsV1,
  type GcodeFact,
  type GcodeFactEvidence,
  GcodeParseError,
  type GcodeParseLimits,
  gcodeFactsSchemaVersion,
  gcodeParserVersion,
} from './types.js';

export const DEFAULT_GCODE_PARSE_LIMITS: GcodeParseLimits = {
  maximumInputBytes: 100 * 1024 * 1024,
  maximumLines: 5_000_000,
  maximumLineBytes: 16 * 1024,
  maximumSegments: 2_000_000,
  maximumMetadataEntries: 1_000,
};

interface Candidate<T> {
  readonly value: T;
  readonly evidence: GcodeFactEvidence;
}

interface AxisRange {
  minimum: number;
  maximum: number;
  observed: boolean;
}

const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function parseGcodeFacts(
  input: Uint8Array,
  limits: GcodeParseLimits = DEFAULT_GCODE_PARSE_LIMITS,
): GcodeCompatibilityFactsV1 {
  validateLimits(limits);
  if (input.byteLength > limits.maximumInputBytes) throw new GcodeParseError('input-too-large');

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new GcodeParseError('invalid-input');
  }
  if (text.includes('\0')) throw new GcodeParseError('invalid-input');

  const target: Candidate<string>[] = [];
  const flavor: Candidate<string>[] = [];
  const nozzles: Candidate<readonly number[]>[] = [];
  const extruders: Candidate<number>[] = [];
  const slicers: Candidate<string>[] = [];
  const ranges: Record<'x' | 'y' | 'z', AxisRange> = {
    x: { minimum: Infinity, maximum: -Infinity, observed: false },
    y: { minimum: Infinity, maximum: -Infinity, observed: false },
    z: { minimum: Infinity, maximum: -Infinity, observed: false },
  };
  const position: Record<'x' | 'y' | 'z', number | null> = { x: null, y: null, z: null };
  let relative = false;
  let boundsIncomplete = false;
  let movementSegments = 0;
  let linesRead = 0;
  let maximumTool = -1;
  let maximumToolLine = 0;
  let firstMovementLine = 0;
  let metadataEntries = 0;

  forEachBoundedLine(text, limits, (rawLine, line) => {
    linesRead = line;
    const semicolon = rawLine.indexOf(';');
    const commandPart = (semicolon < 0 ? rawLine : rawLine.slice(0, semicolon)).trim();
    if (semicolon >= 0) {
      const comment = rawLine.slice(semicolon + 1).trim();
      metadataEntries += collectMetadata(comment, line, {
        target,
        flavor,
        nozzles,
        extruders,
        slicers,
      });
      if (metadataEntries > limits.maximumMetadataEntries)
        throw new GcodeParseError('metadata-limit-exceeded');
    }

    const tokens = commandPart.toUpperCase().split(/\s+/).filter(Boolean);
    const commandIndex = tokens.findIndex((token) => /^(?:G|M|T)\d+/.test(token));
    const command = commandIndex < 0 ? undefined : tokens[commandIndex];
    if (!command) return;
    if (command === 'G90') relative = false;
    if (command === 'G91') relative = true;
    if (command === 'G20') {
      boundsIncomplete = true;
      return;
    }
    if (command === 'G21') return;
    if (/^T\d+$/.test(command)) {
      const tool = Number(command.slice(1));
      if (Number.isSafeInteger(tool) && tool <= 255 && tool >= maximumTool) {
        maximumTool = tool;
        maximumToolLine = line;
      }
      return;
    }
    if (['G2', 'G02', 'G3', 'G03', 'G5', 'G05', 'G6', 'G06', 'G28', 'G53'].includes(command)) {
      // Arc/spline envelopes and homing are deliberately not approximated by endpoints. Doing so
      // could make a too-small build volume appear compatible.
      boundsIncomplete = true;
      return;
    }
    if (command === 'G92') {
      for (const axis of ['x', 'y', 'z'] as const) {
        const value = axisValue(tokens.slice(commandIndex + 1), axis.toUpperCase());
        if (value === undefined) continue;
        position[axis] = value;
        boundsIncomplete = true;
      }
      return;
    }
    if (/^G(?:0?0|0?1).+/.test(command)) {
      // Compact/no-separator forms are intentionally unsupported rather than partially parsed.
      boundsIncomplete = true;
      return;
    }
    if (command !== 'G0' && command !== 'G00' && command !== 'G1' && command !== 'G01') return;

    movementSegments += 1;
    if (firstMovementLine === 0) firstMovementLine = line;
    if (movementSegments > limits.maximumSegments)
      throw new GcodeParseError('segment-limit-exceeded');
    for (const axis of ['x', 'y', 'z'] as const) {
      const value = axisValue(tokens.slice(commandIndex + 1), axis.toUpperCase());
      if (value === undefined) continue;
      const current = position[axis];
      if (relative && current === null) {
        boundsIncomplete = true;
        continue;
      }
      const next = relative ? (current as number) + value : value;
      if (!Number.isFinite(next) || Math.abs(next) > 1_000_000)
        throw new GcodeParseError('invalid-number');
      position[axis] = next;
      ranges[axis].minimum = Math.min(ranges[axis].minimum, next);
      ranges[axis].maximum = Math.max(ranges[axis].maximum, next);
      ranges[axis].observed = true;
    }
  });

  if (maximumTool >= 0)
    extruders.push({
      value: maximumTool + 1,
      evidence: { source: 'command', line: maximumToolLine, key: 'tool-selection' },
    });

  return {
    schemaVersion: gcodeFactsSchemaVersion,
    parser: { name: 'yuki-gcode', version: gcodeParserVersion },
    buildBounds: boundsFact(ranges, firstMovementLine, boundsIncomplete),
    targetPrinter: scalarFact(target, normalizeText),
    flavor: scalarFact(flavor, normalizeFlavor),
    nozzleDiametersMm: arrayFact(nozzles),
    extruderCount: scalarFact(extruders, (value) => value),
    slicer: scalarFact(slicers, normalizeText),
    statistics: { linesRead, movementSegments },
  };
}

function forEachBoundedLine(
  text: string,
  limits: GcodeParseLimits,
  visit: (line: string, lineNumber: number) => void,
): void {
  // The whole input is byte-bounded before decoding. Per-line byte limits are checked without
  // allocating another encoded copy for ordinary ASCII G-code.
  let start = 0;
  let lineNumber = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text.charCodeAt(index) !== 10) continue;
    if (index === text.length && start === text.length) break;
    lineNumber += 1;
    if (lineNumber > limits.maximumLines) throw new GcodeParseError('line-limit-exceeded');
    let line = text.slice(start, index);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    // ASCII is overwhelmingly common. Non-ASCII is measured precisely to prevent UTF-8 bypasses.
    const approximateBytes = line.length;
    if (
      approximateBytes > limits.maximumLineBytes ||
      (/[\u0080-\uFFFF]/.test(line) &&
        new TextEncoder().encode(line).byteLength > limits.maximumLineBytes)
    )
      throw new GcodeParseError('line-too-long');
    visit(line, lineNumber);
    start = index + 1;
  }
}

function axisValue(tokens: readonly string[], axis: string): number | undefined {
  const matching = tokens.filter((candidate) => candidate.startsWith(axis));
  if (matching.length > 1) throw new GcodeParseError('invalid-number');
  const token = matching[0];
  if (!token) return undefined;
  const raw = token.slice(1).replace(/\*\d+$/, '');
  if (!numberPattern.test(raw)) throw new GcodeParseError('invalid-number');
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new GcodeParseError('invalid-number');
  return value;
}

interface MetadataCandidates {
  target: Candidate<string>[];
  flavor: Candidate<string>[];
  nozzles: Candidate<readonly number[]>[];
  extruders: Candidate<number>[];
  slicers: Candidate<string>[];
}

function collectMetadata(comment: string, line: number, output: MetadataCandidates): number {
  const before =
    output.target.length +
    output.flavor.length +
    output.nozzles.length +
    output.extruders.length +
    output.slicers.length;
  const generated = /^(?:generated (?:by|with)|sliced (?:by|with))\s+(.{1,128})$/i.exec(comment);
  if (generated?.[1]) add(output.slicers, generated[1], line, 'generator');

  const pair = /^([A-Za-z0-9_. -]{1,64})\s*(?:=|:)\s*(.{1,256})$/.exec(comment);
  if (!pair?.[1] || !pair[2]) return candidateCount(output) - before;
  const key = pair[1]
    .trim()
    .toLowerCase()
    .replace(/[ .-]+/g, '_');
  const value = pair[2].trim();
  if (['printer_model', 'printer_settings_id', 'target_machine_name', 'machine_name'].includes(key))
    add(output.target, value, line, key);
  else if (['flavor', 'gcode_flavor', 'g_code_flavor'].includes(key))
    add(output.flavor, value, line, key);
  else if (['nozzle_diameter', 'nozzle_diameters'].includes(key)) {
    const parsed = numericList(value, 0.01, 10);
    if (parsed) {
      const source = evidence(line, key);
      output.nozzles.push({ value: parsed, evidence: source });
    }
  } else if (['extruder_count', 'extruders'].includes(key)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 256)
      output.extruders.push({ value: parsed, evidence: evidence(line, key) });
  } else if (['generated_by', 'slicer'].includes(key)) add(output.slicers, value, line, key);
  return candidateCount(output) - before;
}

function candidateCount(output: MetadataCandidates): number {
  return (
    output.target.length +
    output.flavor.length +
    output.nozzles.length +
    output.extruders.length +
    output.slicers.length
  );
}

function add(output: Candidate<string>[], value: string, line: number, key: string): void {
  const clean = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join('')
    .trim()
    .slice(0, 128);
  if (clean) output.push({ value: clean, evidence: evidence(line, key) });
}

function evidence(line: number, key: string): GcodeFactEvidence {
  return { source: 'comment', line, key };
}

function numericList(value: string, minimum: number, maximum: number): readonly number[] | null {
  const parts = value.split(/\s*[,;]\s*/).filter(Boolean);
  if (parts.length === 0 || parts.length > 256) return null;
  const values = parts.map(Number);
  return values.every((item) => Number.isFinite(item) && item >= minimum && item <= maximum)
    ? values
    : null;
}

function scalarFact<T>(
  candidates: readonly Candidate<T>[],
  normalize: (value: T) => T,
): GcodeFact<T> {
  if (candidates.length === 0) return { status: 'unknown', reason: 'not-found' };
  const groups = new Map<string, { value: T; evidence: GcodeFactEvidence[] }>();
  for (const candidate of candidates) {
    const value = normalize(candidate.value);
    const key = JSON.stringify(value);
    const group = groups.get(key) ?? { value, evidence: [] };
    group.evidence.push(candidate.evidence);
    groups.set(key, group);
  }
  if (groups.size !== 1) return { status: 'unknown', reason: 'ambiguous' };
  const group = groups.values().next().value;
  if (!group) return { status: 'unknown', reason: 'not-found' };
  return { status: 'known', value: group.value, evidence: group.evidence };
}

function arrayFact(
  candidates: readonly Candidate<readonly number[]>[],
): GcodeFact<readonly number[]> {
  return scalarFact(candidates, (values) => [...values].sort((left, right) => left - right));
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeFlavor(value: string): string {
  const normalized = normalizeText(value).replace(/[\s_-]+/g, '');
  const aliases: Record<string, string> = {
    marlin: 'marlin',
    marlin2: 'marlin2',
    reprap: 'reprap',
    reprapfirmware: 'reprapfirmware',
    klipper: 'klipper',
    makerware: 'makerware',
    mach3: 'mach3',
  };
  return aliases[normalized] ?? `other:${normalized.slice(0, 64)}`;
}

function boundsFact(
  ranges: Record<'x' | 'y' | 'z', AxisRange>,
  firstMovementLine: number,
  incomplete: boolean,
): GcodeFact<GcodeBuildBounds> {
  if (incomplete || !ranges.x.observed || !ranges.y.observed || !ranges.z.observed)
    return { status: 'unknown', reason: 'incomplete' };
  const value: GcodeBuildBounds = {
    minimum: { x: ranges.x.minimum, y: ranges.y.minimum, z: ranges.z.minimum },
    maximum: { x: ranges.x.maximum, y: ranges.y.maximum, z: ranges.z.maximum },
    size: {
      width: ranges.x.maximum - ranges.x.minimum,
      depth: ranges.y.maximum - ranges.y.minimum,
      height: ranges.z.maximum - ranges.z.minimum,
    },
    unit: 'mm',
  };
  return {
    status: 'known',
    value,
    evidence: [{ source: 'command', line: firstMovementLine, key: 'linear-endpoint-bounds' }],
  };
}

function validateLimits(limits: GcodeParseLimits): void {
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError('G-code parse limits must be positive integers.');
}
