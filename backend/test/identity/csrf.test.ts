import { randomBytes } from 'node:crypto';

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  createIdentityCsrfTokenSource,
  preAuthCookieName,
  sessionCookieName,
} from '../../src/identity/index.js';

describe('identity CSRF token source', () => {
  it('binds tokens to either the authenticated or pre-authentication cookie', () => {
    const source = createIdentityCsrfTokenSource(randomBytes(32));
    const authenticated = requestWithCookie(`${sessionCookieName}=session-a`);
    const otherSession = requestWithCookie(`${sessionCookieName}=session-b`);
    const preAuthentication = requestWithCookie(`${preAuthCookieName}=pre-auth`);

    expect(source(authenticated)).toEqual(expect.any(String));
    expect(source(authenticated)).not.toBe(source(otherSession));
    expect(source(preAuthentication)).toEqual(expect.any(String));
    expect(source(requestWithCookie(undefined))).toBeUndefined();
  });
});

function requestWithCookie(cookie: string | undefined): FastifyRequest {
  return { headers: cookie === undefined ? {} : { cookie } } as FastifyRequest;
}
