import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpApplication, HttpError } from '../../../src/platform/http/index.js';
import {
  type PrinterControlService,
  registerPrinterControlFeature,
} from '../../../src/printing/controls/index.js';

describe('printer control HTTP contract', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;

  afterEach(async () => application?.close());

  it('protects both control endpoints with the owner boundary', async () => {
    application = await createHttpApplication();
    registerPrinterControlFeature(application, {
      service: {} as PrinterControlService,
      identity: {
        requireOwner: async () => {
          throw new HttpError(401, 'authentication_required', 'Authentication is required');
        },
        ownerForRequest: () => {
          throw new Error('Unauthenticated requests have no owner');
        },
      },
    });
    for (const suffix of ['control-confirmations', 'controls']) {
      const response = await application.inject({
        method: 'POST',
        url: `/api/v1/printing/printers/${uuid(1)}/${suffix}`,
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('issues a complete challenge and accepts its token idempotently', async () => {
    application = await createHttpApplication();
    const issue = vi.fn(async () => ({
      token: 'challenge',
      expiresAt: new Date('2026-07-28T12:02:00.000Z'),
      action: 'pause' as const,
      printer: { id: uuid(1), name: 'Workshop' },
      queueEntryId: uuid(2),
      parameters: {},
      safetyNotice: 'Confirm physical safety.',
    }));
    const accept = vi.fn(async () => ({ commandId: uuid(3), state: 'pending' as const }));
    registerPrinterControlFeature(application, {
      service: { issue, accept } as unknown as PrinterControlService,
      identity: {
        requireOwner: async () => {},
        ownerForRequest: () => ({
          owner: { id: uuid(9), username: 'owner' },
          sessionId: uuid(8),
        }),
      },
    });

    const challenge = await application.inject({
      method: 'POST',
      url: `/api/v1/printing/printers/${uuid(1)}/control-confirmations`,
      payload: { action: 'pause', queueEntryId: uuid(2) },
    });
    expect(challenge.statusCode).toBe(201);
    expect(challenge.json()).toMatchObject({
      action: 'pause',
      queueEntryId: uuid(2),
      printer: { name: 'Workshop' },
      safetyNotice: 'Confirm physical safety.',
    });
    expect(issue).toHaveBeenCalledWith(uuid(9), uuid(1), {
      action: 'pause',
      queueEntryId: uuid(2),
    });

    const accepted = await application.inject({
      method: 'POST',
      url: `/api/v1/printing/printers/${uuid(1)}/controls`,
      headers: { 'idempotency-key': 'pause-once' },
      payload: { confirmationToken: 'confirmation-token' },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ commandId: uuid(3), state: 'pending' });
    expect(accept).toHaveBeenCalledWith(uuid(9), uuid(1), 'confirmation-token', 'pause-once');
  });
});

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
