import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpApplication, HttpError } from '../../../src/platform/http/index.js';
import {
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
