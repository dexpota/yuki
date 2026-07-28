import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OwnerContext } from '../../identity/index.js';
import { HttpError } from '../../platform/http/index.js';
import {
  NotificationConflictError,
  NotificationNotFoundError,
  type NotificationService,
} from './service.js';

export interface NotificationIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export function registerNotificationFeature(
  application: FastifyInstance,
  options: {
    readonly identity: NotificationIdentityBoundary;
    readonly service: NotificationService;
  },
): void {
  const authenticated = { preHandler: options.identity.requireOwner };
  const ownerId = (request: FastifyRequest) => options.identity.ownerForRequest(request).owner.id;

  application.get('/api/v1/notifications', authenticated, async (request) => {
    const query = objectValue(request.query);
    const result = await call(() =>
      options.service.list(ownerId(request), {
        ...(query.unread === undefined ? {} : { unreadOnly: boolean(query.unread, 'unread') }),
        ...(query.limit === undefined ? {} : { limit: integer(query.limit, 'limit') }),
      }),
    );
    return {
      notifications: result.notifications.map(response),
      unreadCount: result.unreadCount,
    };
  });

  application.put(
    '/api/v1/notifications/:notificationId/read-state',
    authenticated,
    async (request) => {
      const body = objectValue(request.body);
      return response(
        await call(() =>
          options.service.setRead(
            ownerId(request),
            pathId(request),
            boolean(body.read, 'read'),
            body.expectedVersion === undefined
              ? undefined
              : integer(body.expectedVersion, 'expectedVersion'),
          ),
        ),
      );
    },
  );

  application.post('/api/v1/notifications/read-all', authenticated, async (request) =>
    call(() => options.service.markAllRead(ownerId(request))),
  );
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof NotificationNotFoundError)
      throw new HttpError(404, 'notification_not_found', error.message);
    if (error instanceof NotificationConflictError)
      throw new HttpError(409, 'notification_conflict', error.message);
    if (error instanceof TypeError)
      throw new HttpError(400, 'notification_request_invalid', error.message);
    throw error;
  }
}

function response(notification: {
  readonly id: string;
  readonly kind: string;
  readonly printAttemptId: string | null;
  readonly printerId: string | null;
  readonly title: string;
  readonly message: string;
  readonly facts: unknown;
  readonly readAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}) {
  return {
    ...notification,
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
    updatedAt: notification.updatedAt.toISOString(),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new HttpError(400, 'notification_request_invalid', 'Request value must be an object.');
  return value as Record<string, unknown>;
}

function pathId(request: FastifyRequest): string {
  const value = objectValue(request.params).notificationId;
  if (typeof value !== 'string' || value.trim() === '')
    throw new HttpError(400, 'notification_request_invalid', 'notificationId must be a string.');
  return value;
}

function integer(value: unknown, name: string): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed))
    throw new HttpError(400, 'notification_request_invalid', `${name} must be an integer.`);
  return parsed;
}

function boolean(value: unknown, name: string): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new HttpError(400, 'notification_request_invalid', `${name} must be a boolean.`);
}
