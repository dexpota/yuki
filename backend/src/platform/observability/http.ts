import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { HealthRegistry } from './health.js';
import type { Logger } from './logger.js';
import { MetricsRegistry } from './metrics.js';

export interface HttpObservabilityOptions {
  readonly service: string;
  readonly logger: Logger;
  readonly health: HealthRegistry;
  readonly metrics?: MetricsRegistry;
  readonly authorizeDiagnostics?: (request: FastifyRequest) => boolean | Promise<boolean>;
}

export function installHttpObservability(
  application: FastifyInstance,
  options: HttpObservabilityOptions,
): MetricsRegistry {
  const metrics = options.metrics ?? new MetricsRegistry();
  const requests = metrics.counter('yuki_http_requests_total', 'Completed HTTP requests', {
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    status: ['1xx', '2xx', '3xx', '4xx', '5xx'],
  });
  const requestDuration = metrics.counter(
    'yuki_http_request_duration_milliseconds_total',
    'Cumulative HTTP request duration in milliseconds',
    {
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      status: ['1xx', '2xx', '3xx', '4xx', '5xx'],
    },
  );

  application.decorateRequest('observabilityStartedAt', 0n);
  application.addHook('onRequest', async (request) => {
    request.observabilityStartedAt = process.hrtime.bigint();
    options.logger.child({ requestId: request.id }).info('http_request_started', {
      method: request.method,
      route: request.routeOptions.url,
    });
  });
  application.addHook('onResponse', async (request, reply) => {
    const elapsed = Number(process.hrtime.bigint() - request.observabilityStartedAt) / 1_000_000;
    const status = `${Math.floor(reply.statusCode / 100)}xx`;
    const labels = { method: normalizeMethod(request.method), status };
    requests.increment(labels);
    requestDuration.increment(labels, elapsed);
    options.logger.child({ requestId: request.id }).info('http_request_completed', {
      method: request.method,
      route: request.routeOptions.url,
      statusCode: reply.statusCode,
      durationMs: Number(elapsed.toFixed(3)),
    });
  });

  application.get('/health/live', async (_request, reply) => reply.send(options.health.liveness()));
  application.get('/health/ready', async (_request, reply) => {
    const snapshot = await options.health.readiness();
    return reply.status(snapshot.status === 'ready' ? 200 : 503).send(snapshot);
  });
  application.get('/diagnostics/metrics', async (request, reply) => {
    if (!(await options.authorizeDiagnostics?.(request))) {
      return reply.status(401).send({ error: 'authentication_required', requestId: request.id });
    }
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.renderPrometheus());
  });
  return metrics;
}

declare module 'fastify' {
  interface FastifyRequest {
    observabilityStartedAt: bigint;
  }
}

function normalizeMethod(method: string): string {
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method)
    ? method
    : 'OPTIONS';
}
