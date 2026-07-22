export const gcodeFactsSchemaVersion = 1 as const;

export interface GcodeFactEvidence {
  readonly source: 'comment' | 'command';
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
  readonly parser: { readonly name: 'yuki-gcode'; readonly version: string };
  readonly buildBounds: GcodeFact<GcodeBuildBounds>;
  readonly targetPrinter: GcodeFact<string>;
  readonly flavor: GcodeFact<string>;
  readonly nozzleDiametersMm: GcodeFact<readonly number[]>;
  readonly extruderCount: GcodeFact<number>;
  readonly slicer: GcodeFact<string>;
  readonly statistics: { readonly linesRead: number; readonly movementSegments: number };
}

export interface GcodeFactsSnapshotV1 {
  readonly schemaVersion: 1;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly capturedAt: string;
  readonly facts: GcodeCompatibilityFactsV1;
}

export interface CreateGcodeFactsSnapshotInput {
  readonly assetId: string;
  readonly assetSha256: string;
  readonly capturedAt: Date;
  readonly facts: unknown;
}
