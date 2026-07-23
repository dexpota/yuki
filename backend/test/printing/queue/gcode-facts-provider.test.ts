import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { ProcessorSupervisorClient } from '../../../src/platform/processor/supervisor/index.js';
import { SupervisorGcodeFactsProvider } from '../../../src/printing/queue/index.js';

describe('supervisor G-code facts provider', () => {
  it('uses the fixed facts operation and validates the processor result', async () => {
    const cleanup = vi.fn(async () => {});
    const execute = vi.fn(async () => ({
      processorResult: { facts: facts() },
      outputs: [],
      cleanup,
    }));
    const provider = new SupervisorGcodeFactsProvider({
      execute,
    } as unknown as ProcessorSupervisorClient);
    await expect(
      provider.parse({ byteSize: 7, open: async () => Readable.from(['G1 X1\n']) }),
    ).resolves.toMatchObject({ schemaVersion: 1, parser: { name: 'yuki-gcode' } });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'parse-gcode-facts',
        inputBytes: 7,
        limits: expect.objectContaining({ maximumInputBytes: 100 * 1024 * 1024 }),
      }),
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

function facts() {
  const absent = { status: 'unknown', reason: 'not-found' };
  return {
    schemaVersion: 1,
    parser: { name: 'yuki-gcode', version: '1.0.0' },
    buildBounds: absent,
    targetPrinter: absent,
    flavor: absent,
    nozzleDiametersMm: absent,
    extruderCount: absent,
    slicer: absent,
    statistics: { linesRead: 1, movementSegments: 0 },
  };
}
