import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { HttpError } from './errors.js';

const validRequestId = /^[A-Za-z0-9._:-]{1,128}$/;

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyKey: string | undefined;
  }
}

export function installRequestContext(application: FastifyInstance): void {
  application.decorateRequest('idempotencyKey');
  application.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);

    try {
      request.idempotencyKey = parseIdempotencyKey(request);
      done();
    } catch (error) {
      done(error as Error);
    }
  });
}

export function requestIdFromHeaders(headers: IncomingHttpHeaders): string {
  const requestId = parseSingleHeader(headers['x-request-id']);
  return requestId !== undefined && validRequestId.test(requestId) ? requestId : randomUUID();
}

export function parseIdempotencyKey(request: Pick<FastifyRequest, 'headers'>): string | undefined {
  const raw = request.headers['idempotency-key'];
  if (raw === undefined) return undefined;
  const key = parseSingleHeader(raw);
  if (key === undefined || !/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw new HttpError(400, 'idempotency_key_invalid', 'Idempotency key is invalid');
  }
  return key;
}

function parseSingleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
