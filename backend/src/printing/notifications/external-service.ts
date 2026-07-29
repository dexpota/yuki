import type { Kysely } from 'kysely';

import type {
  NotificationDatabaseSchema,
  NotificationDeliveryView,
  NotificationWebhookConfigurationView,
} from './contracts.js';
import type { NotificationWebhookDestinationPolicy } from './webhook.js';

export interface NotificationSecretVault {
  encrypt(plaintext: string, purpose: string): string;
  decrypt(envelope: string, purpose: string): string;
}

export interface UpdateNotificationWebhookConfiguration {
  readonly enabled?: boolean;
  readonly endpointUrl?: string;
  readonly bearerToken?: string;
  readonly clearBearerToken?: boolean;
  readonly expectedVersion: number;
}

export interface ResolvedNotificationWebhookConfiguration {
  readonly enabled: boolean;
  readonly endpointUrl: string | null;
  readonly bearerToken: string | null;
}

export class NotificationConfigurationConflictError extends Error {
  override readonly name = 'NotificationConfigurationConflictError';
}

export class NotificationConfigurationInvalidError extends Error {
  override readonly name = 'NotificationConfigurationInvalidError';
}

export class ExternalNotificationService {
  public constructor(
    private readonly database: Kysely<NotificationDatabaseSchema>,
    private readonly secrets: NotificationSecretVault,
    private readonly destinations: NotificationWebhookDestinationPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async configuration(ownerId: string): Promise<NotificationWebhookConfigurationView> {
    const row = await this.database
      .selectFrom('notification_webhook_configurations')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row
      ? {
          mode: 'webhook',
          enabled: row.enabled,
          configured: true,
          endpointDisplay: row.endpoint_origin,
          bearerTokenConfigured: row.encrypted_bearer_token !== null,
          version: row.version,
          updatedAt: row.updated_at,
        }
      : emptyConfiguration();
  }

  public async updateConfiguration(
    ownerId: string,
    input: UpdateNotificationWebhookConfiguration,
  ): Promise<NotificationWebhookConfigurationView> {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
      throw new TypeError('expectedVersion is invalid');
    if (input.bearerToken !== undefined && input.clearBearerToken === true)
      throw new TypeError('bearerToken and clearBearerToken cannot be combined');
    const current = await this.database
      .selectFrom('notification_webhook_configurations')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if ((current?.version ?? 0) !== input.expectedVersion)
      throw new NotificationConfigurationConflictError(
        'Webhook configuration was changed by another request',
      );
    const endpoint =
      input.endpointUrl === undefined
        ? current
          ? {
              origin: current.endpoint_origin,
              encryptedUrl: current.encrypted_endpoint_url,
            }
          : undefined
        : await this.destinations.validate(input.endpointUrl).then((destination) => ({
            origin: destination.display,
            encryptedUrl: this.secrets.encrypt(destination.url, endpointPurpose(ownerId)),
          }));
    if (!endpoint)
      throw new NotificationConfigurationInvalidError(
        'endpointUrl is required before configuring a webhook',
      );
    const enabled = input.enabled ?? current?.enabled ?? false;
    const encryptedBearerToken = this.#updatedToken(
      ownerId,
      current?.encrypted_bearer_token,
      input,
    );
    const now = this.now();
    if (!current) {
      try {
        await this.database
          .insertInto('notification_webhook_configurations')
          .values({
            owner_id: ownerId,
            endpoint_origin: endpoint.origin,
            encrypted_endpoint_url: endpoint.encryptedUrl,
            encrypted_bearer_token: encryptedBearerToken,
            enabled,
            created_at: now,
            updated_at: now,
            version: 1,
          })
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (uniqueViolation(error))
          throw new NotificationConfigurationConflictError(
            'Webhook configuration was changed by another request',
          );
        throw error;
      }
    } else {
      const changed = await this.database
        .updateTable('notification_webhook_configurations')
        .set({
          endpoint_origin: endpoint.origin,
          encrypted_endpoint_url: endpoint.encryptedUrl,
          encrypted_bearer_token: encryptedBearerToken,
          enabled,
          updated_at: now,
          version: current.version + 1,
        })
        .where('owner_id', '=', ownerId)
        .where('version', '=', input.expectedVersion)
        .executeTakeFirst();
      if (changed.numUpdatedRows !== 1n)
        throw new NotificationConfigurationConflictError(
          'Webhook configuration was changed by another request',
        );
    }
    return this.configuration(ownerId);
  }

  public async resolvedConfiguration(
    ownerId: string,
  ): Promise<ResolvedNotificationWebhookConfiguration> {
    const row = await this.database
      .selectFrom('notification_webhook_configurations')
      .select(['encrypted_endpoint_url', 'encrypted_bearer_token', 'enabled'])
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!row) return { enabled: false, endpointUrl: null, bearerToken: null };
    return {
      enabled: row.enabled,
      endpointUrl: this.secrets.decrypt(row.encrypted_endpoint_url, endpointPurpose(ownerId)),
      bearerToken:
        row.encrypted_bearer_token === null
          ? null
          : this.secrets.decrypt(row.encrypted_bearer_token, tokenPurpose(ownerId)),
    };
  }

  public async deliveries(
    ownerId: string,
    limit = 50,
  ): Promise<readonly NotificationDeliveryView[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError('limit must be an integer from 1 through 100');
    const rows = await this.database
      .selectFrom('notification_deliveries as delivery')
      .innerJoin('notifications as notification', 'notification.id', 'delivery.notification_id')
      .select([
        'delivery.id',
        'delivery.notification_id',
        'delivery.state',
        'delivery.attempt_count',
        'delivery.response_status',
        'delivery.last_error_code',
        'delivery.last_error_message',
        'delivery.last_attempt_at',
        'delivery.delivered_at',
        'delivery.updated_at',
        'notification.kind',
        'notification.title',
      ])
      .where('delivery.owner_id', '=', ownerId)
      .where('notification.owner_id', '=', ownerId)
      .orderBy('delivery.updated_at', 'desc')
      .orderBy('delivery.id', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      notificationId: row.notification_id,
      kind: row.kind,
      title: row.title,
      state: row.state,
      attemptCount: row.attempt_count,
      responseStatus: row.response_status,
      lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message,
      lastAttemptAt: row.last_attempt_at,
      deliveredAt: row.delivered_at,
      updatedAt: row.updated_at,
    }));
  }

  #updatedToken(
    ownerId: string,
    current: string | null | undefined,
    input: UpdateNotificationWebhookConfiguration,
  ): string | null {
    if (input.clearBearerToken === true) return null;
    if (input.bearerToken === undefined) return current ?? null;
    const token = input.bearerToken.trim();
    if (token.length < 8 || token.length > 2048)
      throw new NotificationConfigurationInvalidError(
        'bearerToken must contain between 8 and 2048 characters',
      );
    return this.secrets.encrypt(token, tokenPurpose(ownerId));
  }
}

function emptyConfiguration(): NotificationWebhookConfigurationView {
  return {
    mode: 'webhook',
    enabled: false,
    configured: false,
    endpointDisplay: null,
    bearerTokenConfigured: false,
    version: 0,
    updatedAt: null,
  };
}

function tokenPurpose(ownerId: string): string {
  return `notification-webhook:${ownerId}:bearer`;
}

function endpointPurpose(ownerId: string): string {
  return `notification-webhook:${ownerId}:endpoint`;
}

function uniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
