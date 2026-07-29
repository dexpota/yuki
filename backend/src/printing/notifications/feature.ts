import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OwnerContext } from '../../identity/index.js';
import { HttpError } from '../../platform/http/index.js';
import {
  NotificationConflictError,
  NotificationNotFoundError,
  type NotificationService,
} from './service.js';
import {
  type ExternalNotificationService,
  NotificationConfigurationConflictError,
  NotificationConfigurationInvalidError,
} from './external-service.js';
import { UnsafeNotificationDestinationError } from './webhook.js';

export interface NotificationIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export function registerNotificationFeature(
  application: FastifyInstance,
  options: {
    readonly identity: NotificationIdentityBoundary;
    readonly service: NotificationService;
    readonly external?: ExternalNotificationService;
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

  if (options.external) {
    const external = options.external;
    application.get('/api/v1/notifications/webhook-configuration', authenticated, (request) =>
      external.configuration(ownerId(request)).then(configurationResponse),
    );
    application.patch(
      '/api/v1/notifications/webhook-configuration',
      authenticated,
      async (request) =>
        externalCall(() =>
          external
            .updateConfiguration(ownerId(request), configurationBody(request.body))
            .then(configurationResponse),
        ),
    );
    application.get('/api/v1/notifications/deliveries', authenticated, async (request) => {
      const query = objectValue(request.query);
      const deliveries = await externalCall(() =>
        external.deliveries(
          ownerId(request),
          query.limit === undefined ? undefined : integer(query.limit, 'limit'),
        ),
      );
      return { deliveries: deliveries.map(deliveryResponse) };
    });
  }
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

async function externalCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof NotificationConfigurationConflictError)
      throw new HttpError(409, 'notification_configuration_conflict', error.message);
    if (
      error instanceof NotificationConfigurationInvalidError ||
      error instanceof UnsafeNotificationDestinationError ||
      error instanceof TypeError
    )
      throw new HttpError(400, 'notification_configuration_invalid', error.message);
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

function configurationResponse(configuration: {
  readonly mode: 'webhook';
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly endpointDisplay: string | null;
  readonly bearerTokenConfigured: boolean;
  readonly version: number;
  readonly updatedAt: Date | null;
}) {
  return {
    ...configuration,
    updatedAt: configuration.updatedAt?.toISOString() ?? null,
  };
}

function deliveryResponse(delivery: {
  readonly lastAttemptAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly updatedAt: Date;
}) {
  return {
    ...delivery,
    lastAttemptAt: delivery.lastAttemptAt?.toISOString() ?? null,
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    updatedAt: delivery.updatedAt.toISOString(),
  };
}

function configurationBody(value: unknown) {
  const body = objectValue(value);
  const keys = ['enabled', 'endpointUrl', 'bearerToken', 'clearBearerToken', 'expectedVersion'];
  if (Object.keys(body).some((key) => !keys.includes(key)))
    throw new HttpError(
      400,
      'notification_configuration_invalid',
      'Configuration contains unsupported fields.',
    );
  return {
    expectedVersion: integer(body.expectedVersion, 'expectedVersion'),
    ...(body.enabled === undefined ? {} : { enabled: boolean(body.enabled, 'enabled') }),
    ...(body.endpointUrl === undefined
      ? {}
      : { endpointUrl: string(body.endpointUrl, 'endpointUrl') }),
    ...(body.bearerToken === undefined
      ? {}
      : { bearerToken: string(body.bearerToken, 'bearerToken') }),
    ...(body.clearBearerToken === undefined
      ? {}
      : { clearBearerToken: boolean(body.clearBearerToken, 'clearBearerToken') }),
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

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new HttpError(400, 'notification_configuration_invalid', `${name} must be a string.`);
  return value;
}
