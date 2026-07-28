import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { PrinterDestination } from '../../../src/printing/printers/public.js';
import { OctoPrintCommandGateway } from '../../../src/printing/start/index.js';

const destination: PrinterDestination = {
  baseUrl: 'http://printer.local/',
  origin: 'http://printer.local',
};

describe('OctoPrint print command gateway', () => {
  it('creates the namespaced folders, streams upload bytes, verifies metadata, and starts', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      if (init?.method === 'GET') return Response.json({ size: 4, hash: 'ab'.repeat(32) });
      return new Response(null, { status: 204 });
    });
    const gateway = new OctoPrintCommandGateway({ fetch: request as typeof fetch });
    await gateway.ensureUploaded(destination, 'secret', {
      path: `yuki/jobs/${uuid(1)}/cube.gcode`,
      filename: 'cube.gcode',
      byteSize: 4,
      checksum: 'ab'.repeat(32),
      open: async () => Readable.from(['G1\n']),
    });
    await gateway.start(destination, 'secret', `yuki/jobs/${uuid(1)}/cube.gcode`);

    expect(requests.map((entry) => [entry.init.method, entry.url])).toEqual([
      ['POST', 'http://printer.local/api/files/local'],
      ['POST', 'http://printer.local/api/files/local'],
      ['POST', 'http://printer.local/api/files/local'],
      ['POST', 'http://printer.local/api/files/local'],
      ['GET', `http://printer.local/api/files/local/yuki/jobs/${uuid(1)}/cube.gcode`],
      ['POST', `http://printer.local/api/files/local/yuki/jobs/${uuid(1)}/cube.gcode`],
    ]);
    const upload = requests[3]?.init;
    expect(upload?.headers).toMatchObject({
      'content-length': expect.any(String),
    });
    expect(upload?.body).toBeInstanceOf(ReadableStream);
    expect(requests[5]?.init.body).toBe(JSON.stringify({ command: 'select', print: true }));
  });

  it('classifies a start timeout as ambiguous and retryable', async () => {
    const gateway = new OctoPrintCommandGateway({
      timeoutMs: 1,
      fetch: vi.fn(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ) as typeof fetch,
    });
    await expect(
      gateway.start(destination, 'secret', `yuki/jobs/${uuid(1)}/cube.gcode`),
    ).rejects.toMatchObject({
      phase: 'start',
      kind: 'timeout',
      retryable: true,
      ambiguous: true,
    });
  });
});

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
