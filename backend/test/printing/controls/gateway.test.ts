import { describe, expect, it, vi } from 'vitest';

import {
  OctoPrintControlGateway,
  type PrinterControlGatewayError,
} from '../../../src/printing/controls/index.js';
import type { PrinterDestination } from '../../../src/printing/printers/public.js';

const destination: PrinterDestination = {
  baseUrl: 'http://printer.local/',
  origin: 'http://printer.local',
};

describe('OctoPrint control gateway', () => {
  it('maps the supported actions to narrow OctoPrint commands', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    });
    const gateway = new OctoPrintControlGateway({ fetch: request as typeof fetch });

    await gateway.execute(destination, 'secret', 'pause', {});
    await gateway.execute(destination, 'secret', 'resume', {});
    await gateway.execute(destination, 'secret', 'cancel', {});
    await gateway.execute(destination, 'secret', 'set_tool_temperature', {
      tool: 'tool0',
      targetCelsius: 205,
    });
    await gateway.execute(destination, 'secret', 'set_bed_temperature', {
      targetCelsius: 60,
    });
    await gateway.execute(destination, 'secret', 'home', { axes: ['x', 'y'] });

    expect(requests).toEqual([
      {
        url: 'http://printer.local/api/job',
        body: { command: 'pause', action: 'pause' },
      },
      {
        url: 'http://printer.local/api/job',
        body: { command: 'pause', action: 'resume' },
      },
      { url: 'http://printer.local/api/job', body: { command: 'cancel' } },
      {
        url: 'http://printer.local/api/printer/tool',
        body: { command: 'target', targets: { tool0: 205 } },
      },
      {
        url: 'http://printer.local/api/printer/bed',
        body: { command: 'target', target: 60 },
      },
      {
        url: 'http://printer.local/api/printer/printhead',
        body: { command: 'home', axes: ['x', 'y'] },
      },
    ]);
  });

  it('treats a command timeout as ambiguous', async () => {
    const gateway = new OctoPrintControlGateway({
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
    await expect(gateway.execute(destination, 'secret', 'cancel', {})).rejects.toEqual(
      expect.objectContaining<Partial<PrinterControlGatewayError>>({
        kind: 'timeout',
        ambiguous: true,
      }),
    );
  });
});
