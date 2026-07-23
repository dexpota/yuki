import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { SupervisorImportContentProcessor } from '../../src/importing/index.js';
import type { ProcessorSupervisorClient } from '../../src/platform/processor/supervisor/index.js';

describe('supervisor import adapter', () => {
  it('detects, extracts, detects members, and retains output streams until batch cleanup', async () => {
    const extractionCleanup = vi.fn(async () => {});
    const execute = vi
      .fn()
      .mockResolvedValueOnce(execution(detection('archive', 'application/zip')))
      .mockResolvedValueOnce({
        processorResult: { expandedBytes: 5 },
        outputs: [
          {
            name: 'parts/cube.stl',
            byteSize: 5,
            checksum: 'a'.repeat(64),
            open: () => Readable.from([Buffer.from('solid')]),
          },
        ],
        cleanup: extractionCleanup,
      })
      .mockResolvedValueOnce(execution(detection('stl', 'model/stl')));
    const adapter = new SupervisorImportContentProcessor({
      execute,
    } as unknown as ProcessorSupervisorClient);

    const batch = await adapter.inspect({
      sessionId: '10000000-0000-4000-8000-000000000001',
      ownerId: 'owner',
      originalFilename: 'models.zip',
      claimedMimeType: 'application/zip',
      checksum: 'b'.repeat(64),
      size: 3,
      openOriginal: async () => Readable.from([Buffer.from('zip')]),
    });

    expect(batch).toMatchObject({
      kind: 'archive',
      originalDetection: { format: 'archive' },
      files: [{ fileKey: 'parts/cube.stl', detection: { format: 'stl' } }],
    });
    const member = batch.files[0];
    if (!member || 'error' in member || !member.open) throw new Error('Expected accepted member');
    const chunks: Buffer[] = [];
    for await (const chunk of await member.open()) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('solid');
    await batch.cleanup?.();
    expect(extractionCleanup).toHaveBeenCalledOnce();
  });
});

function execution(processorResult: unknown) {
  return { processorResult, outputs: [], cleanup: vi.fn(async () => {}) };
}

function detection(format: 'archive' | 'stl', mimeType: string) {
  return { format, mimeType, confidence: 'signature', metadata: {}, warnings: [] };
}
