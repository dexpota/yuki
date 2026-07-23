import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { ProcessorSupervisorClient } from '../../platform/processor/supervisor/index.js';
import { type GcodeCompatibilityFactsV1, parseProcessorGcodeFacts } from '../gcode/index.js';

export interface GcodeFactsProvider {
  parse(input: {
    readonly byteSize: number;
    readonly open: () => Promise<Readable>;
  }): Promise<GcodeCompatibilityFactsV1>;
}

export interface SupervisorGcodeFactsProviderLimits {
  readonly maximumInputBytes: number;
  readonly maximumLines: number;
  readonly maximumLineBytes: number;
  readonly maximumSegments: number;
  readonly maximumMetadataEntries: number;
}

export const defaultSupervisorGcodeFactsProviderLimits: SupervisorGcodeFactsProviderLimits = {
  maximumInputBytes: 100 * 1024 * 1024,
  maximumLines: 5_000_000,
  maximumLineBytes: 16 * 1024,
  maximumSegments: 2_000_000,
  maximumMetadataEntries: 1_000,
};

export class SupervisorGcodeFactsProvider implements GcodeFactsProvider {
  constructor(
    private readonly client: ProcessorSupervisorClient,
    private readonly limits: SupervisorGcodeFactsProviderLimits = defaultSupervisorGcodeFactsProviderLimits,
  ) {}

  async parse(input: {
    readonly byteSize: number;
    readonly open: () => Promise<Readable>;
  }): Promise<GcodeCompatibilityFactsV1> {
    const execution = await this.client.execute({
      requestId: `gcode-facts:${randomUUID()}`,
      operation: 'parse-gcode-facts',
      inputBytes: input.byteSize,
      input: await input.open(),
      limits: { ...this.limits },
    });
    try {
      if (execution.outputs.length !== 0)
        throw new TypeError('G-code facts processor returned unexpected files.');
      const result = record(execution.processorResult);
      return parseProcessorGcodeFacts(result.facts);
    } finally {
      await execution.cleanup();
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('G-code facts processor result is invalid.');
  return value as Record<string, unknown>;
}
