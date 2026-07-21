import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { HttpError } from './errors.js';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface CsrfOptions {
  readonly allowedOrigins: readonly string[];
  readonly tokenForRequest: (request: FastifyRequest) => string | undefined;
  readonly exempt?: (request: FastifyRequest) => boolean;
}

export function installCsrfProtection(application: FastifyInstance, options: CsrfOptions): void {
  const origins = new Set(options.allowedOrigins.map(normalizeOrigin));
  application.addHook('preHandler', (request, _reply, done) => {
    if (safeMethods.has(request.method) || options.exempt?.(request) === true) {
      done();
      return;
    }

    try {
      const origin = singleHeader(request.headers.origin);
      if (origin === undefined || !isAllowedOrigin(origin, origins)) {
        throw new HttpError(403, 'csrf_origin_rejected', 'Request origin is not allowed');
      }

      const supplied = singleHeader(request.headers['x-csrf-token']);
      const expected = options.tokenForRequest(request);
      if (
        supplied === undefined ||
        expected === undefined ||
        !constantTimeEqual(supplied, expected)
      ) {
        throw new HttpError(403, 'csrf_token_invalid', 'CSRF token is missing or invalid');
      }
      done();
    } catch (error) {
      done(error as Error);
    }
  });
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('CSRF origins must use HTTP or HTTPS');
  }
  return url.origin;
}

function isAllowedOrigin(value: string, allowed: ReadonlySet<string>): boolean {
  try {
    return allowed.has(normalizeOrigin(value));
  } catch {
    return false;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
