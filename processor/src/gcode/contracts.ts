import type { GcodeCompatibilityFactsV1, GcodeParseLimits } from './types.js';

export const gcodeFactsOperation = 'parse-gcode-facts';
export const gcodeFactsPayloadVersion = 1;
export const gcodeFactsInputPath = '/input/source';

export interface ParseGcodeFactsRequest {
  readonly operation: typeof gcodeFactsOperation;
  readonly payload: {
    readonly version: typeof gcodeFactsPayloadVersion;
    readonly inputPath: typeof gcodeFactsInputPath;
    readonly limits: GcodeParseLimits;
  };
}

export type ParseGcodeFactsResult =
  | { readonly status: 'ready'; readonly facts: GcodeCompatibilityFactsV1 }
  | { readonly status: 'failed'; readonly reason: string };
