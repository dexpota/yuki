import { describe, expect, it, vi } from 'vitest';

import {
  applicationJobIdFromPath,
  applicationJobPath,
  type MonitoringGatewayError,
  OctoPrintMonitoringGateway,
} from '../../../src/printing/monitoring/public.js';

const destination = {
  origin: 'http://printer.test:5000',
  baseUrl: 'http://printer.test:5000/',
};
const jobId = '90000000-0000-4000-8000-000000000001';

describe('OctoPrint monitoring gateway', () => {
  it('normalizes current facts and recognizes only the stable application namespace', async () => {
    const request = responses(
      {
        state: 'Printing',
        job: {
          file: {
            name: 'part.gcode',
            path: applicationJobPath(jobId, 'part.gcode'),
            origin: 'local',
          },
        },
        progress: { completion: 42.5, printTime: 120, printTimeLeft: 180 },
      },
      {
        state: { text: 'Printing' },
        temperature: { tool0: { actual: 205.2, target: 210 }, bed: { actual: 59, target: 60 } },
      },
    );
    const facts = await new OctoPrintMonitoringGateway({ fetch: request }).observe(
      destination,
      'secret',
    );

    expect(facts).toMatchObject({
      state: 'printing',
      activeJob: { kind: 'local', applicationJobId: jobId },
      progressPercent: 42.5,
      elapsedSeconds: 120,
      remainingSeconds: 180,
    });
    expect(facts.temperatures).toHaveLength(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      new URL('http://printer.test:5000/api/job'),
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(applicationJobIdFromPath('part.gcode')).toBeNull();
  });

  it('classifies a non-namespaced active file as external, never by filename', async () => {
    const facts = await new OctoPrintMonitoringGateway({
      fetch: responses(
        {
          state: 'Printing',
          job: {
            file: { name: `yuki-${jobId}.gcode`, path: 'uploads/part.gcode', origin: 'local' },
          },
          progress: {},
        },
        { state: { text: 'Printing' }, temperature: {} },
      ),
    }).observe(destination, 'secret');
    expect(facts.activeJob).toEqual({ kind: 'external' });
  });

  it('marks an active response with no file identity ambiguous', async () => {
    const facts = await new OctoPrintMonitoringGateway({
      fetch: responses(
        { state: 'Paused', job: {}, progress: {} },
        { state: { text: 'Paused' }, temperature: {} },
      ),
    }).observe(destination, 'secret');
    expect(facts.activeJob).toEqual({ kind: 'ambiguous' });
  });

  it('bounds responses, sanitizes failures, and disables redirects', async () => {
    const gateway = new OctoPrintMonitoringGateway({
      maxResponseBytes: 8,
      fetch: async () => new Response('123456789'),
    });
    await expect(gateway.observe(destination, 'do-not-leak')).rejects.toMatchObject({
      name: 'MonitoringGatewayError',
      kind: 'response_too_large',
      message: 'Printer monitoring request failed',
    });
    await expect(gateway.observe(destination, 'do-not-leak')).rejects.not.toThrow('do-not-leak');
  });

  it('classifies authorization failures as terminal', async () => {
    const gateway = new OctoPrintMonitoringGateway({
      fetch: async () => new Response('', { status: 401 }),
    });
    await expect(gateway.observe(destination, 'secret')).rejects.toEqual(
      expect.objectContaining<Partial<MonitoringGatewayError>>({
        kind: 'unauthorized',
        retryable: false,
      }),
    );
  });
});

function responses(...bodies: readonly unknown[]) {
  let index = 0;
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(bodies[index++])));
}
