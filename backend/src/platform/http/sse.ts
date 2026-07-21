import type { Writable } from 'node:stream';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { HttpError } from './errors.js';

export interface SseEvent {
  readonly id: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly revision: string | number;
  readonly kind: string;
}

export interface SseSubscription extends AsyncIterable<SseEvent> {
  readonly requiresRefresh: boolean;
  close(): void;
  nextWithin(
    milliseconds: number,
    signal: AbortSignal,
  ): Promise<IteratorResult<SseEvent> | 'heartbeat'>;
}

export interface SseHubOptions {
  readonly retainedEvents?: number;
  readonly subscriberBuffer?: number;
}

export class SseHub {
  readonly #retainedEvents: number;
  readonly #subscriberBuffer: number;
  readonly #history: SseEvent[] = [];
  readonly #subscribers = new Set<EventQueue>();

  public constructor(options: SseHubOptions = {}) {
    this.#retainedEvents = positiveInteger(options.retainedEvents ?? 1_000, 'retainedEvents');
    this.#subscriberBuffer = positiveInteger(options.subscriberBuffer ?? 100, 'subscriberBuffer');
  }

  public publish(event: SseEvent): void {
    validateEvent(event);
    this.#history.push(event);
    if (this.#history.length > this.#retainedEvents) this.#history.shift();

    for (const subscriber of this.#subscribers) {
      if (!subscriber.push(event)) {
        subscriber.close(new Error('SSE subscriber exceeded its bounded buffer'));
        this.#subscribers.delete(subscriber);
      }
    }
  }

  public subscribe(lastEventId?: string): SseSubscription {
    const queue = new EventQueue(this.#subscriberBuffer, () => this.#subscribers.delete(queue));
    let requiresRefresh = false;

    if (lastEventId !== undefined) {
      const index = this.#history.findIndex((event) => event.id === lastEventId);
      if (index === -1) {
        requiresRefresh = true;
      } else {
        const replay = this.#history.slice(index + 1);
        if (replay.length > this.#subscriberBuffer) {
          requiresRefresh = true;
        } else {
          for (const event of replay) queue.push(event);
        }
      }
    }

    this.#subscribers.add(queue);
    return {
      requiresRefresh,
      close: () => queue.close(),
      nextWithin: (milliseconds, signal) => queue.nextWithin(milliseconds, signal),
      [Symbol.asyncIterator]: () => queue,
    };
  }
}

export interface SendSseOptions {
  readonly heartbeatMs?: number;
  readonly signal?: AbortSignal;
}

export async function sendSse(
  request: FastifyRequest,
  reply: FastifyReply,
  hub: SseHub,
  options: SendSseOptions = {},
): Promise<void> {
  const heartbeatMs = positiveInteger(options.heartbeatMs ?? 15_000, 'heartbeatMs');
  const lastEventId = parseLastEventId(request.headers['last-event-id']);
  const subscription = hub.subscribe(lastEventId);
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  reply.raw.once('close', abort);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted === true) cancellation.abort(options.signal.reason);

  reply.hijack();
  reply.raw.writeHead(200, {
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
    'x-request-id': request.id,
  });

  try {
    await writeWithBackpressure(reply.raw, 'retry: 3000\n\n', cancellation.signal);
    if (subscription.requiresRefresh) {
      await writeWithBackpressure(
        reply.raw,
        'event: refresh-required\ndata: {"reason":"retention_window_exceeded"}\n\n',
        cancellation.signal,
      );
    }

    while (!cancellation.signal.aborted) {
      const next = await subscription.nextWithin(heartbeatMs, cancellation.signal);
      if (next === 'heartbeat') {
        await writeWithBackpressure(reply.raw, ': heartbeat\n\n', cancellation.signal);
      } else if (next.done === true) {
        break;
      } else {
        await writeWithBackpressure(reply.raw, encodeSseEvent(next.value), cancellation.signal);
      }
    }
  } catch (error) {
    if (!cancellation.signal.aborted) throw error;
  } finally {
    subscription.close();
    reply.raw.off('close', abort);
    options.signal?.removeEventListener('abort', abort);
    if (!reply.raw.destroyed) reply.raw.end();
  }
}

export function encodeSseEvent(event: SseEvent): string {
  validateEvent(event);
  return `id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify({
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    revision: event.revision,
    kind: event.kind,
  })}\n\n`;
}

function parseLastEventId(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isSafeSseField(value)) {
    throw new HttpError(400, 'last_event_id_invalid', 'Last-Event-ID is invalid');
  }
  return value;
}

function validateEvent(event: SseEvent): void {
  if (
    !isSafeSseField(event.id) ||
    !isSafeSseField(event.resourceType) ||
    !isSafeSseField(event.resourceId) ||
    !isSafeSseField(event.kind) ||
    (typeof event.revision === 'number'
      ? !Number.isSafeInteger(event.revision)
      : !isSafeSseField(event.revision))
  ) {
    throw new TypeError('SSE event contains an invalid field');
  }
}

function isSafeSseField(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value)
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

async function writeWithBackpressure(
  destination: Writable,
  chunk: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
  if (destination.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      destination.off('drain', drained);
      destination.off('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason ?? new Error('aborted'));
    };
    destination.once('drain', drained);
    destination.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

class EventQueue implements AsyncIterator<SseEvent> {
  readonly #values: SseEvent[] = [];
  readonly #waiting: Array<(result: IteratorResult<SseEvent>) => void> = [];
  #closed = false;

  public constructor(
    readonly capacity: number,
    readonly onClose: () => void,
  ) {}

  public push(event: SseEvent): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiting.shift();
    if (waiter !== undefined) {
      waiter({ value: event, done: false });
      return true;
    }
    if (this.#values.length >= this.capacity) return false;
    this.#values.push(event);
    return true;
  }

  public next(): Promise<IteratorResult<SseEvent>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  public nextWithin(
    milliseconds: number,
    signal: AbortSignal,
  ): Promise<IteratorResult<SseEvent> | 'heartbeat'> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));

    return new Promise((resolve, reject) => {
      let settled = false;
      const complete = (result: IteratorResult<SseEvent>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve(result);
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        removeWaiter();
        reject(signal.reason ?? new Error('aborted'));
      };
      const removeWaiter = () => {
        const index = this.#waiting.indexOf(complete);
        if (index !== -1) this.#waiting.splice(index, 1);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        removeWaiter();
        signal.removeEventListener('abort', abort);
        resolve('heartbeat');
      }, milliseconds);

      this.#waiting.push(complete);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  public close(_error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose();
    for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined, done: true });
  }
}
