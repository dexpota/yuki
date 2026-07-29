import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import { PrinterDestinationPolicy, UnsafePrinterDestinationError } from '../printers/public.js';

export interface NotificationWebhookDestination {
  readonly url: string;
  readonly display: string;
  readonly addresses: readonly string[];
}

export class UnsafeNotificationDestinationError extends Error {
  override readonly name = 'UnsafeNotificationDestinationError';
}

export interface NotificationWebhookDestinationPolicyOptions {
  readonly allowedHostnames?: ReadonlySet<string>;
  readonly lookupAddresses?: (hostname: string) => Promise<readonly string[]>;
}

export class NotificationWebhookDestinationPolicy {
  readonly #destinations: PrinterDestinationPolicy;

  public constructor(options: NotificationWebhookDestinationPolicyOptions = {}) {
    this.#destinations = new PrinterDestinationPolicy({
      allowPrivateNetworks: false,
      ...(options.allowedHostnames ? { allowedHostnames: options.allowedHostnames } : {}),
      ...(options.lookupAddresses ? { lookupAddresses: options.lookupAddresses } : {}),
    });
  }

  public async validate(rawUrl: string): Promise<NotificationWebhookDestination> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new UnsafeNotificationDestinationError('Webhook URL is invalid');
    }
    if (parsed.protocol !== 'https:')
      throw new UnsafeNotificationDestinationError('Webhook URL must use HTTPS');
    try {
      const destination = await this.#destinations.validate(rawUrl);
      const normalized = new URL(destination.baseUrl);
      return {
        url: normalized.toString(),
        display: normalized.origin,
        addresses: destination.addresses ?? [],
      };
    } catch (error) {
      if (error instanceof UnsafePrinterDestinationError) {
        throw new UnsafeNotificationDestinationError(
          error.message.replace(/^Printer /, 'Webhook '),
        );
      }
      throw error;
    }
  }
}

export interface WebhookNotification {
  readonly schema: 'yuki.notification.v1';
  readonly notificationId: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly title: string;
  readonly message: string;
  readonly printAttemptId: string | null;
  readonly printerId: string | null;
  readonly facts: unknown;
}

export interface NotificationSenderInput {
  readonly endpointUrl: string;
  readonly bearerToken: string | null;
  readonly notification: WebhookNotification;
}

export interface NotificationSender {
  send(input: NotificationSenderInput): Promise<{ readonly statusCode: number }>;
}

export class NotificationSendError extends Error {
  override readonly name = 'NotificationSendError';

  public constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly statusCode: number | null = null,
  ) {
    super(message);
  }
}

export interface WebhookNotificationSenderOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maximumRequestBytes?: number;
  readonly maximumResponseBytes?: number;
}

export class WebhookNotificationSender implements NotificationSender {
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #timeoutMs: number;
  readonly #maximumRequestBytes: number;
  readonly #maximumResponseBytes: number;

  public constructor(
    private readonly destinations: NotificationWebhookDestinationPolicy,
    options: WebhookNotificationSenderOptions = {},
  ) {
    this.#fetch = options.fetch;
    this.#timeoutMs = positive(options.timeoutMs ?? 10_000, 'timeoutMs');
    this.#maximumRequestBytes = positive(
      options.maximumRequestBytes ?? 64 * 1024,
      'maximumRequestBytes',
    );
    this.#maximumResponseBytes = positive(
      options.maximumResponseBytes ?? 64 * 1024,
      'maximumResponseBytes',
    );
  }

  public async send(input: NotificationSenderInput): Promise<{ readonly statusCode: number }> {
    let destination: NotificationWebhookDestination;
    try {
      destination = await this.destinations.validate(input.endpointUrl);
    } catch (error) {
      if (error instanceof UnsafeNotificationDestinationError)
        throw new NotificationSendError('unsafe_destination', error.message, false);
      throw error;
    }
    const body = JSON.stringify(input.notification);
    if (Buffer.byteLength(body) > this.#maximumRequestBytes) {
      throw new NotificationSendError(
        'notification_payload_too_large',
        'Notification payload exceeds the delivery limit',
        false,
      );
    }
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'Yuki-Notification-Webhook/1',
      'idempotency-key': input.notification.notificationId,
      ...(input.bearerToken === null ? {} : { authorization: `Bearer ${input.bearerToken}` }),
    };
    let statusCode: number;
    try {
      if (this.#fetch) {
        const response = await this.#fetch(destination.url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(this.#timeoutMs),
          headers,
          body,
        });
        statusCode = response.status;
        await drainBounded(response.body, this.#maximumResponseBytes);
      } else {
        statusCode = await postHttps(
          destination,
          body,
          headers,
          this.#timeoutMs,
          this.#maximumResponseBytes,
        );
      }
    } catch (error) {
      if (error instanceof NotificationSendError) throw error;
      throw new NotificationSendError(
        'webhook_network_error',
        'Webhook request failed before a response was received',
        true,
      );
    }
    if (statusCode >= 200 && statusCode < 300) return { statusCode };
    const retryable =
      statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
    throw new NotificationSendError(
      retryable ? 'webhook_temporary_response' : 'webhook_rejected',
      `Webhook returned HTTP ${statusCode}`,
      retryable,
      statusCode,
    );
  }
}

function postHttps(
  destination: NotificationWebhookDestination,
  body: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  maximumResponseBytes: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const address = destination.addresses[0];
    if (!address) {
      reject(new Error('Webhook destination has no approved address'));
      return;
    }
    const lookup: LookupFunction = (_hostname, options, callback) => {
      const family = isIP(address);
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const request = httpsRequest(
      destination.url,
      {
        method: 'POST',
        lookup,
        headers: {
          ...headers,
          'content-length': String(Buffer.byteLength(body)),
        },
      },
      (response) => {
        const statusCode = response.statusCode;
        if (statusCode === undefined) {
          response.destroy();
          reject(new Error('Webhook response omitted an HTTP status'));
          return;
        }
        let received = 0;
        let settled = false;
        response.on('data', (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > maximumResponseBytes && !settled) {
            settled = true;
            resolve(statusCode);
            response.destroy();
          }
        });
        response.once('end', () => {
          if (!settled) resolve(statusCode);
        });
        response.once('error', (error) => {
          if (!settled) reject(error);
        });
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Webhook request timed out')));
    request.once('error', reject);
    request.end(body);
  });
}

async function drainBounded(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}
