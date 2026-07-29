import { describe, expect, it, vi } from 'vitest';

import {
  NotificationSendError,
  NotificationWebhookDestinationPolicy,
  UnsafeNotificationDestinationError,
  WebhookNotificationSender,
} from '../../../src/printing/notifications/index.js';

describe('notification webhook boundary', () => {
  it('accepts only resolved public HTTPS destinations without URL credentials or query data', async () => {
    const policy = policyFor('203.0.113.10');
    await expect(policy.validate('https://hooks.example.test/yuki')).resolves.toEqual({
      url: 'https://hooks.example.test/yuki/',
      display: 'https://hooks.example.test',
      addresses: ['203.0.113.10'],
    });
    await expect(policy.validate('http://hooks.example.test/yuki')).rejects.toThrow(
      'must use HTTPS',
    );
    await expect(policy.validate('https://user:secret@hooks.example.test/yuki')).rejects.toThrow(
      'must not contain credentials',
    );
    await expect(policy.validate('https://hooks.example.test/yuki?token=secret')).rejects.toThrow(
      'must not contain a query',
    );
    await expect(
      policyFor('127.0.0.1').validate('https://hooks.example.test'),
    ).rejects.toBeInstanceOf(UnsafeNotificationDestinationError);
    await expect(
      policyFor('::ffff:10.0.0.1').validate('https://hooks.example.test'),
    ).rejects.toThrow('address is not allowed');
  });

  it('sends the versioned payload with idempotency and optional bearer authentication', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer delivery-secret');
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('notification-1');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        schema: 'yuki.notification.v1',
        notificationId: 'notification-1',
        kind: 'print_completed',
      });
      return new Response('accepted', { status: 202 });
    });
    const sender = new WebhookNotificationSender(policyFor('203.0.113.10'), { fetch });
    await expect(
      sender.send({
        endpointUrl: 'https://hooks.example.test/yuki',
        bearerToken: 'delivery-secret',
        notification: notification(),
      }),
    ).resolves.toEqual({ statusCode: 202 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [503, true, 'webhook_temporary_response'],
    [429, true, 'webhook_temporary_response'],
    [401, false, 'webhook_rejected'],
  ] as const)(
    'classifies HTTP %s without retaining response content',
    async (status, retryable, code) => {
      const sender = new WebhookNotificationSender(policyFor('203.0.113.10'), {
        fetch: async () => new Response('upstream secret details', { status }),
      });
      const error = await sender
        .send({
          endpointUrl: 'https://hooks.example.test/yuki',
          bearerToken: null,
          notification: notification(),
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NotificationSendError);
      expect(error).toMatchObject({ code, retryable, statusCode: status });
      expect((error as Error).message).not.toContain('secret details');
    },
  );

  it('classifies network failures as retryable and revalidates DNS for every send', async () => {
    const lookup = vi.fn(async () => ['203.0.113.10']);
    const sender = new WebhookNotificationSender(
      new NotificationWebhookDestinationPolicy({ lookupAddresses: lookup }),
      {
        fetch: async () => {
          throw new Error('socket failed with secret URL');
        },
      },
    );
    await expect(
      sender.send({
        endpointUrl: 'https://hooks.example.test/yuki',
        bearerToken: null,
        notification: notification(),
      }),
    ).rejects.toMatchObject({ code: 'webhook_network_error', retryable: true });
    expect(lookup).toHaveBeenCalledOnce();
  });
});

function policyFor(address: string) {
  return new NotificationWebhookDestinationPolicy({
    lookupAddresses: async () => [address],
  });
}

function notification() {
  return {
    schema: 'yuki.notification.v1' as const,
    notificationId: 'notification-1',
    kind: 'print_completed',
    occurredAt: '2026-07-29T08:00:00.000Z',
    title: 'Print completed',
    message: 'Workshop: cube.gcode',
    printAttemptId: null,
    printerId: null,
    facts: { schemaVersion: 1 },
  };
}
