export const gcodeFactsSchemaVersion = 1 as const;
export const gcodeParserVersion = '1.0.0' as const;

export interface GcodeParseLimits {
  readonly maximumInputBytes: number;
  readonly maximumLines: number;
  readonly maximumLineBytes: number;
  readonly maximumSegments: number;
  readonly maximumMetadataEntries: number;
}

export type GcodeEvidenceSource = 'comment' | 'command';

export interface GcodeFactEvidence {
  readonly source: GcodeEvidenceSource;
  readonly line: number;
  readonly key: string;
}

export type GcodeFact<T> =
  | { readonly status: 'known'; readonly value: T; readonly evidence: readonly GcodeFactEvidence[] }
  | { readonly status: 'unknown'; readonly reason: 'not-found' | 'ambiguous' | 'incomplete' };

export interface GcodeBuildBounds {
  readonly minimum: { readonly x: number; readonly y: number; readonly z: number };
  readonly maximum: { readonly x: number; readonly y: number; readonly z: number };
  readonly size: { readonly width: number; readonly depth: number; readonly height: number };
  readonly unit: 'mm';
}

export interface GcodeCompatibilityFactsV1 {
  readonly schemaVersion: typeof gcodeFactsSchemaVersion;
  readonly parser: { readonly name: 'yuki-gcode'; readonly version: typeof gcodeParserVersion };
  readonly buildBounds: GcodeFact<GcodeBuildBounds>;
  readonly targetPrinter: GcodeFact<string>;
  readonly flavor: GcodeFact<string>;
  readonly nozzleDiametersMm: GcodeFact<readonly number[]>;
  readonly extruderCount: GcodeFact<number>;
  readonly slicer: GcodeFact<string>;
  readonly statistics: { readonly linesRead: number; readonly movementSegments: number };
}

export type GcodeParseErrorCode =
  | 'input-too-large'
  | 'invalid-input'
  | 'line-too-long'
  | 'line-limit-exceeded'
  | 'segment-limit-exceeded'
  | 'metadata-limit-exceeded'
  | 'invalid-number';

const errorMessages: Record<GcodeParseErrorCode, string> = {
  'input-too-large': 'G-code input exceeds the configured byte limit.',
  'invalid-input': 'G-code input is not valid text.',
  'line-too-long': 'A G-code line exceeds the configured byte limit.',
  'line-limit-exceeded': 'G-code input exceeds the configured line limit.',
  'segment-limit-exceeded': 'G-code input exceeds the configured movement limit.',
  'metadata-limit-exceeded': 'G-code input exceeds the configured metadata limit.',
  'invalid-number': 'G-code contains an invalid numeric value.',
};

export class GcodeParseError extends Error {
  override readonly name = 'GcodeParseError';

  constructor(readonly code: GcodeParseErrorCode) {
    super(errorMessages[code]);
  }
}
