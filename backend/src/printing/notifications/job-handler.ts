import type { Kysely } from 'kysely';

import {
  claimJob,
  completeJob,
  failJob,
  type Job,
  type RetryPolicy,
} from '../../platform/jobs/index.js';
import { SecretEncryptionError } from '../../identity/index.js';
import type { NotificationDatabaseSchema } from './contracts.js';
import type { ExternalNotificationService } from './external-service.js';
import {
  NotificationSendError,
  type NotificationSender,
  type WebhookNotification,
} from './webhook.js';

export const externalNotificationJobType = 'notification.external.delivery';
export const externalNotificationPayloadVersion = 1;

export async function handleExternalNotificationJob(
  database: Kysely<NotificationDatabaseSchema>,
  external: ExternalNotificationService,
  sender: NotificationSender,
  job: Job,
  retryPolicy: RetryPolicy = { baseDelayMs: 5_000, maximumDelayMs: 300_000 },
): Promise<void> {
  if (
    job.type !== externalNotificationJobType ||
    job.payloadVersion !== externalNotificationPayloadVersion ||
    !job.leaseToken
  )
    throw new TypeError('Unsupported or unclaimed notification delivery job');
  const payload = parsePayload(job.payload);
  const notification = await database
    .selectFrom('notifications')
    .selectAll()
    .where('id', '=', payload.notificationId)
    .where('owner_id', '=', payload.ownerId)
    .executeTakeFirst();
  if (!notification) {
    await failJob(
      database,
      job.id,
      job.leaseToken,
      {
        code: 'notification_not_found',
        message: 'Notification delivery source does not exist',
        retryable: false,
      },
      retryPolicy,
    );
    return;
  }

  try {
    const configuration = await external.resolvedConfiguration(payload.ownerId);
    if (!configuration.enabled || configuration.endpointUrl === null) {
      await database
        .updateTable('notification_deliveries')
        .set({
          state: 'disabled',
          response_status: null,
          last_error_code: 'channel_disabled',
          last_error_message: 'External notification channel is disabled',
          updated_at: new Date(),
        })
        .where('owner_id', '=', payload.ownerId)
        .where('notification_id', '=', notification.id)
        .executeTakeFirst();
      await completeJob(database, job.id, job.leaseToken);
      return;
    }
    const result = await sender.send({
      endpointUrl: configuration.endpointUrl,
      bearerToken: configuration.bearerToken,
      notification: webhookPayload(notification),
    });
    const now = new Date();
    await database
      .updateTable('notification_deliveries')
      .set({
        state: 'succeeded',
        attempt_count: job.attempts,
        response_status: result.statusCode,
        last_error_code: null,
        last_error_message: null,
        last_attempt_at: now,
        delivered_at: now,
        updated_at: now,
      })
      .where('owner_id', '=', payload.ownerId)
      .where('notification_id', '=', notification.id)
      .executeTakeFirst();
    await completeJob(database, job.id, job.leaseToken, now);
  } catch (error) {
    if (!(error instanceof NotificationSendError) && !(error instanceof SecretEncryptionError)) {
      throw error;
    }
    const failure = deliveryFailure(error);
    const failed = await failJob(database, job.id, job.leaseToken, failure, retryPolicy);
    const now = new Date();
    await database
      .updateTable('notification_deliveries')
      .set({
        state: failed.state === 'queued' ? 'retrying' : 'failed',
        attempt_count: job.attempts,
        response_status: error instanceof NotificationSendError ? error.statusCode : null,
        last_error_code: failure.code,
        last_error_message: failure.message,
        last_attempt_at: now,
        delivered_at: null,
        updated_at: now,
      })
      .where('owner_id', '=', payload.ownerId)
      .where('notification_id', '=', notification.id)
      .executeTakeFirst();
  }
}

export async function processNextExternalNotificationJob(
  database: Kysely<NotificationDatabaseSchema>,
  external: ExternalNotificationService,
  sender: NotificationSender,
  options: {
    readonly workerId: string;
    readonly leaseDurationMs: number;
    readonly retryPolicy?: RetryPolicy;
  },
): Promise<boolean> {
  const job = await claimJob(database, {
    workerId: options.workerId,
    leaseDurationMs: options.leaseDurationMs,
    types: [externalNotificationJobType],
  });
  if (!job) return false;
  await handleExternalNotificationJob(database, external, sender, job, options.retryPolicy);
  return true;
}

function parsePayload(value: unknown): {
  readonly schemaVersion: 1;
  readonly notificationId: string;
  readonly ownerId: string;
} {
  if (
    !value ||
    typeof value !== 'object' ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('notificationId' in value) ||
    typeof value.notificationId !== 'string' ||
    !('ownerId' in value) ||
    typeof value.ownerId !== 'string'
  )
    throw new TypeError('Notification delivery payload is invalid');
  return {
    schemaVersion: 1,
    notificationId: value.notificationId,
    ownerId: value.ownerId,
  };
}

function webhookPayload(notification: {
  readonly id: string;
  readonly kind: string;
  readonly print_attempt_id: string | null;
  readonly printer_id: string | null;
  readonly title: string;
  readonly message: string;
  readonly facts: unknown;
  readonly created_at: Date;
}): WebhookNotification {
  return {
    schema: 'yuki.notification.v1',
    notificationId: notification.id,
    kind: notification.kind,
    occurredAt: notification.created_at.toISOString(),
    title: notification.title,
    message: notification.message,
    printAttemptId: notification.print_attempt_id,
    printerId: notification.printer_id,
    facts: notification.facts,
  };
}

function deliveryFailure(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  if (error instanceof NotificationSendError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof SecretEncryptionError)
    return {
      code: 'notification_configuration_invalid',
      message: 'External notification configuration could not be decrypted',
      retryable: false,
    };
  return {
    code: 'notification_delivery_failed',
    message: 'External notification delivery failed unexpectedly',
    retryable: true,
  };
}
