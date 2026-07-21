import { describe, expect, it } from 'vitest';

import {
  createHttpApplication,
  encodeSseEvent,
  sendSse,
  SseHub,
  type SseEvent,
} from '../../src/platform/http/index.js';

const event = (id: string): SseEvent => ({
  id,
  resourceType: 'printer',
  resourceId: 'printer-1',
  revision: Number(id),
  kind: 'updated',
});

describe('SSE transport primitives', () => {
  it('encodes bounded invalidation hints without using them as resource state', () => {
    expect(encodeSseEvent(event('1'))).toBe(
      'id: 1\nevent: updated\ndata: {"resourceType":"printer","resourceId":"printer-1","revision":1,"kind":"updated"}\n\n',
    );
    expect(() => encodeSseEvent({ ...event('1'), kind: 'bad\nevent' })).toThrow(TypeError);
  });

  it('replays retained events following Last-Event-ID', async () => {
    const hub = new SseHub({ retainedEvents: 3, subscriberBuffer: 3 });
    hub.publish(event('1'));
    hub.publish(event('2'));
    hub.publish(event('3'));
    const subscription = hub.subscribe('1');
    const iterator = subscription[Symbol.asyncIterator]();

    expect(subscription.requiresRefresh).toBe(false);
    expect((await iterator.next()).value.id).toBe('2');
    expect((await iterator.next()).value.id).toBe('3');
    subscription.close();
  });

  it('signals a full refresh when the replay window was exceeded', () => {
    const hub = new SseHub({ retainedEvents: 2 });
    hub.publish(event('2'));
    hub.publish(event('3'));
    const subscription = hub.subscribe('1');
    expect(subscription.requiresRefresh).toBe(true);
    subscription.close();
  });

  it('disconnects a subscriber that cannot keep up with its bounded queue', async () => {
    const hub = new SseHub({ subscriberBuffer: 1 });
    const subscription = hub.subscribe();
    hub.publish(event('1'));
    hub.publish(event('2'));
    const iterator = subscription[Symbol.asyncIterator]();
    expect((await iterator.next()).value.id).toBe('1');
    expect((await iterator.next()).done).toBe(true);
  });

  it('produces heartbeats without consuming a future event', async () => {
    const hub = new SseHub();
    const subscription = hub.subscribe();
    const result = await subscription.nextWithin(1, new AbortController().signal);
    expect(result).toBe('heartbeat');
    hub.publish(event('1'));
    expect((await subscription[Symbol.asyncIterator]().next()).value.id).toBe('1');
    subscription.close();
  });

  it('serves events with anti-buffering headers and closes on cancellation', async () => {
    const application = await createHttpApplication();
    const hub = new SseHub();
    application.get('/api/v1/events', async (request, reply) => {
      const cancellation = new AbortController();
      setImmediate(() => {
        hub.publish(event('1'));
        setImmediate(() => cancellation.abort());
      });
      await sendSse(request, reply, hub, { signal: cancellation.signal });
    });

    const response = await application.inject({ method: 'GET', url: '/api/v1/events' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-cache, no-transform');
    expect(response.body).toContain('retry: 3000\n\n');
    expect(response.body).toContain('id: 1\nevent: updated\n');
    await application.close();
  });

  it('tells a reconnecting client to refresh when its event is no longer retained', async () => {
    const application = await createHttpApplication();
    const hub = new SseHub({ retainedEvents: 1 });
    hub.publish(event('2'));
    application.get('/api/v1/events', async (request, reply) => {
      const cancellation = new AbortController();
      setImmediate(() => cancellation.abort());
      await sendSse(request, reply, hub, { signal: cancellation.signal });
    });

    const response = await application.inject({
      method: 'GET',
      url: '/api/v1/events',
      headers: { 'last-event-id': '1' },
    });
    expect(response.body).toContain('event: refresh-required\n');
    await application.close();
  });
});
