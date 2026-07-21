import { describe, expect, it } from 'vitest';

import { createHttpApplication } from '../../src/platform/http/application.js';
import { HealthRegistry } from '../../src/platform/observability/health.js';
import { installHttpObservability } from '../../src/platform/observability/http.js';
import { createJsonLogger } from '../../src/platform/observability/logger.js';

describe('HTTP observability', () => {
  it('separates liveness from dependency-aware readiness', async () => {
    const health = new HealthRegistry();
    health.addReadinessCheck('database', async () => {
      throw new Error('postgres://user:password@database/private');
    });
    health.setAcceptingWork(true);
    const application = await observedApplication(health);

    const live = await application.inject({ method: 'GET', url: '/health/live' });
    const ready = await application.inject({ method: 'GET', url: '/health/ready' });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'alive' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'not_ready', checks: { database: 'down' } });
    expect(ready.body).not.toContain('password');
    await application.close();
  });

  it('requires authentication for metrics and uses bounded labels', async () => {
    const health = new HealthRegistry();
    health.setAcceptingWork(true);
    const application = await observedApplication(health, true);

    const denied = await application.inject({ method: 'GET', url: '/diagnostics/metrics' });
    const allowed = await application.inject({
      method: 'GET',
      url: '/diagnostics/metrics',
      headers: { authorization: 'test-only' },
    });

    expect(denied.statusCode).toBe(401);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toContain('yuki_http_requests_total{method="GET",status="4xx"} 1');
    expect(allowed.body).not.toContain('authorization');
    await application.close();
  });

  it('logs request IDs without query strings or credentials', async () => {
    const lines: string[] = [];
    const health = new HealthRegistry();
    health.setAcceptingWork(true);
    const application = await createHttpApplication();
    installHttpObservability(application, {
      service: 'api',
      logger: createJsonLogger({ service: 'api', write: (line) => lines.push(line) }),
      health,
    });

    await application.inject({
      method: 'GET',
      url: '/missing?token=do-not-log',
      headers: { 'x-request-id': 'request-123', cookie: 'session=do-not-log' },
    });

    expect(lines).not.toHaveLength(0);
    expect(lines.join('\n')).toContain('request-123');
    expect(lines.join('\n')).not.toContain('do-not-log');
    await application.close();
  });
});

async function observedApplication(health: HealthRegistry, allowTestHeader = false) {
  const application = await createHttpApplication();
  installHttpObservability(application, {
    service: 'test',
    logger: createJsonLogger({ service: 'test', write: () => {} }),
    health,
    authorizeDiagnostics: (request) =>
      allowTestHeader && request.headers.authorization === 'test-only',
  });
  return application;
}
