import { describe, expect, it, vi } from 'vitest';

import {
  createHttpApplication,
  generateOpenApi,
  HttpError,
} from '../../src/platform/http/index.js';

describe('HTTP application conventions', () => {
  it('validates request schemas and returns sanitized stable errors', async () => {
    const application = await createHttpApplication();
    application.post(
      '/api/v1/example',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: { name: { type: 'string', minLength: 1 } },
          },
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['accepted'],
              properties: { accepted: { type: 'boolean' } },
            },
          },
        },
      },
      async () => ({ accepted: true }),
    );

    const response = await application.inject({
      method: 'POST',
      url: '/api/v1/example',
      payload: { name: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.json()).toEqual({
      error: {
        code: 'request_validation_failed',
        message: 'The request is invalid',
        requestId: response.headers['x-request-id'],
        details: [{ field: '/name', issue: 'minLength' }],
      },
    });
    await application.close();
  });

  it('correlates safe incoming IDs and parses bounded idempotency keys', async () => {
    const application = await createHttpApplication();
    application.post('/api/v1/command', async (request) => ({ key: request.idempotencyKey }));

    const response = await application.inject({
      method: 'POST',
      url: '/api/v1/command',
      headers: { 'x-request-id': 'request-123', 'idempotency-key': 'operation-456' },
    });
    expect(response.headers['x-request-id']).toBe('request-123');
    expect(response.json()).toEqual({ key: 'operation-456' });

    const invalid = await application.inject({
      method: 'POST',
      url: '/api/v1/command',
      headers: { 'idempotency-key': 'x'.repeat(129) },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('idempotency_key_invalid');
    await application.close();
  });

  it('never exposes an unexpected error and reports it internally', async () => {
    const onUnhandledError = vi.fn();
    const application = await createHttpApplication({ errors: { onUnhandledError } });
    application.get('/api/v1/failure', async () => {
      throw new Error('database password is secret');
    });

    const response = await application.inject({ method: 'GET', url: '/api/v1/failure' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('database password');
    expect(response.json().error.code).toBe('internal_error');
    expect(onUnhandledError).toHaveBeenCalledOnce();
    await application.close();
  });

  it('enforces same-origin and a session-bound CSRF token for mutations', async () => {
    const application = await createHttpApplication({
      csrf: {
        allowedOrigins: ['https://yuki.local'],
        tokenForRequest: () => 'session-token',
      },
    });
    application.post('/api/v1/mutation', async () => ({ ok: true }));

    const rejected = await application.inject({
      method: 'POST',
      url: '/api/v1/mutation',
      headers: { origin: 'https://attacker.example', 'x-csrf-token': 'session-token' },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe('csrf_origin_rejected');

    const accepted = await application.inject({
      method: 'POST',
      url: '/api/v1/mutation',
      headers: { origin: 'https://yuki.local', 'x-csrf-token': 'session-token' },
    });
    expect(accepted.statusCode).toBe(200);
    await application.close();
  });

  it('generates OpenAPI from registered route schemas', async () => {
    const application = await createHttpApplication();
    application.get(
      '/api/v1/ping',
      {
        schema: {
          operationId: 'getPing',
          response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
        },
      },
      async () => ({ ok: true }),
    );

    const document = (await generateOpenApi(application)) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/api/v1/ping']).toBeDefined();
    await application.close();
  });

  it('preserves explicit public errors', async () => {
    const application = await createHttpApplication();
    application.get('/api/v1/conflict', async () => {
      throw new HttpError(409, 'version_conflict', 'The resource changed');
    });
    const response = await application.inject({ method: 'GET', url: '/api/v1/conflict' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('version_conflict');
    await application.close();
  });
});
