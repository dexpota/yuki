import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpApplication, HttpError } from '../../../src/platform/http/index.js';
import {
  type ExternalNotificationService,
  type NotificationService,
  registerNotificationFeature,
} from '../../../src/printing/notifications/index.js';

describe('notification HTTP contract', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;

  afterEach(async () => application?.close());

  it('protects notification reads and mutations with the owner boundary', async () => {
    application = await createHttpApplication();
    registerNotificationFeature(application, {
      service: {} as NotificationService,
      external: {} as ExternalNotificationService,
      identity: {
        requireOwner: async () => {
          throw new HttpError(401, 'authentication_required', 'Authentication is required');
        },
        ownerForRequest: () => {
          throw new Error('Unauthenticated requests have no owner');
        },
      },
    });
    expect(
      (await application.inject({ method: 'GET', url: '/api/v1/notifications' })).statusCode,
    ).toBe(401);
    expect(
      (
        await application.inject({
          method: 'GET',
          url: '/api/v1/notifications/webhook-configuration',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await application.inject({
          method: 'PUT',
          url: `/api/v1/notifications/${uuid(1)}/read-state`,
          payload: { read: true },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('returns owner-scoped notifications and forwards optimistic read state', async () => {
    const list = vi.fn(async () => ({
      notifications: [notification()],
      unreadCount: 1,
    }));
    const setRead = vi.fn(async () => ({ ...notification(), readAt: new Date() }));
    application = await createHttpApplication();
    registerNotificationFeature(application, {
      service: { list, setRead } as unknown as NotificationService,
      identity: {
        requireOwner: async () => {},
        ownerForRequest: () => ({
          owner: { id: uuid(9), username: 'owner' },
          sessionId: uuid(8),
        }),
      },
    });

    const listed = await application.inject({
      method: 'GET',
      url: '/api/v1/notifications?unread=true&limit=20',
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      unreadCount: 1,
      notifications: [{ kind: 'print_completed', readAt: null }],
    });
    expect(list).toHaveBeenCalledWith(uuid(9), { unreadOnly: true, limit: 20 });

    const updated = await application.inject({
      method: 'PUT',
      url: `/api/v1/notifications/${uuid(1)}/read-state`,
      payload: { read: true, expectedVersion: 1 },
    });
    expect(updated.statusCode).toBe(200);
    expect(setRead).toHaveBeenCalledWith(uuid(9), uuid(1), true, 1);
  });

  it('masks webhook secrets and exposes sanitized delivery diagnostics', async () => {
    const configuration = vi.fn(async () => ({
      mode: 'webhook' as const,
      enabled: true,
      configured: true,
      endpointDisplay: 'https://hooks.example.test',
      bearerTokenConfigured: true,
      version: 2,
      updatedAt: new Date('2026-07-29T09:00:00.000Z'),
    }));
    const updateConfiguration = vi.fn(configuration);
    const deliveries = vi.fn(async () => [
      {
        id: uuid(4),
        notificationId: uuid(1),
        kind: 'print_failed' as const,
        title: 'Print failed',
        state: 'retrying' as const,
        attemptCount: 2,
        responseStatus: 503,
        lastErrorCode: 'webhook_temporary_response',
        lastErrorMessage: 'Webhook returned HTTP 503',
        lastAttemptAt: new Date('2026-07-29T09:00:00.000Z'),
        deliveredAt: null,
        updatedAt: new Date('2026-07-29T09:00:00.000Z'),
      },
    ]);
    application = await createHttpApplication();
    registerNotificationFeature(application, {
      service: {} as NotificationService,
      external: {
        configuration,
        updateConfiguration,
        deliveries,
      } as unknown as ExternalNotificationService,
      identity: {
        requireOwner: async () => {},
        ownerForRequest: () => ({
          owner: { id: uuid(9), username: 'owner' },
          sessionId: uuid(8),
        }),
      },
    });

    const current = await application.inject({
      method: 'GET',
      url: '/api/v1/notifications/webhook-configuration',
    });
    expect(current.json()).toEqual({
      mode: 'webhook',
      enabled: true,
      configured: true,
      endpointDisplay: 'https://hooks.example.test',
      bearerTokenConfigured: true,
      version: 2,
      updatedAt: '2026-07-29T09:00:00.000Z',
    });
    expect(JSON.stringify(current.json())).not.toMatch(/secret|token":/i);

    const updated = await application.inject({
      method: 'PATCH',
      url: '/api/v1/notifications/webhook-configuration',
      payload: {
        enabled: false,
        bearerToken: 'replacement-secret',
        expectedVersion: 2,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updateConfiguration).toHaveBeenCalledWith(uuid(9), {
      enabled: false,
      bearerToken: 'replacement-secret',
      expectedVersion: 2,
    });

    const diagnostics = await application.inject({
      method: 'GET',
      url: '/api/v1/notifications/deliveries?limit=5',
    });
    expect(diagnostics.json()).toMatchObject({
      deliveries: [
        {
          state: 'retrying',
          responseStatus: 503,
          lastAttemptAt: '2026-07-29T09:00:00.000Z',
        },
      ],
    });
    expect(deliveries).toHaveBeenCalledWith(uuid(9), 5);
  });
});

function notification() {
  const now = new Date('2026-07-28T10:00:00.000Z');
  return {
    id: uuid(1),
    kind: 'print_completed' as const,
    printAttemptId: uuid(2),
    printerId: uuid(3),
    title: 'Print completed',
    message: 'Workshop: cube.gcode',
    facts: { schemaVersion: 1 },
    readAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}
