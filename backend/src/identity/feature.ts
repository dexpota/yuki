import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';

import { HttpError } from '../platform/http/index.js';
import {
  clearHttpOnlyCookie,
  type IdentityCookieOptions,
  readCookie,
  setHttpOnlyCookie,
} from './cookies.js';
import type { IdentityDatabaseSchema } from './schema.js';
import { SecretVault } from './secrets.js';
import { IdentityService, InvalidCredentialsError, type OwnerContext } from './service.js';
import {
  IdentityStore,
  type IssuedSession,
  type SessionPolicy,
  SetupAlreadyCompletedError,
} from './store.js';
import {
  deriveCsrfToken,
  newOpaqueToken,
  preAuthCookieName,
  readIdentityKey,
  sessionCookieName,
} from './tokens.js';

const preAuthLifetimeMs = 30 * 60 * 1000;

export interface IdentityFeatureOptions {
  readonly database: Kysely<IdentityDatabaseSchema>;
  readonly csrfKey: Buffer;
  readonly masterKey: Buffer;
  readonly cookie: IdentityCookieOptions;
  readonly session?: Partial<SessionPolicy>;
}

export interface IdentityFeature {
  readonly secrets: SecretVault;
  readonly service: IdentityService;
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export interface IdentityKeys {
  readonly csrfKey: Buffer;
  readonly masterKey: Buffer;
}

export function readIdentityKeys(environment: NodeJS.ProcessEnv): IdentityKeys {
  return {
    csrfKey: readIdentityKey(environment.YUKI_CSRF_KEY, 'YUKI_CSRF_KEY'),
    masterKey: readIdentityKey(environment.YUKI_MASTER_KEY, 'YUKI_MASTER_KEY'),
  };
}

/**
 * Synchronous token source for F06's global CSRF hook. It supports the
 * pre-authentication cookie used by setup/login and the authenticated session
 * cookie. Origin validation remains owned by the HTTP platform.
 */
export function createIdentityCsrfTokenSource(
  csrfKey: Buffer,
): (request: FastifyRequest) => string | undefined {
  assertKey(csrfKey, 'CSRF key');
  return (request) => {
    const source = readCookie(request, sessionCookieName) ?? readCookie(request, preAuthCookieName);
    return source === undefined ? undefined : deriveCsrfToken(source, csrfKey);
  };
}

export function registerIdentityFeature(
  application: FastifyInstance,
  options: IdentityFeatureOptions,
): IdentityFeature {
  assertKey(options.csrfKey, 'CSRF key');
  assertKey(options.masterKey, 'installation master key');
  const policy: SessionPolicy = {
    absoluteLifetimeMs: options.session?.absoluteLifetimeMs ?? 7 * 24 * 60 * 60 * 1000,
    idleLifetimeMs: options.session?.idleLifetimeMs ?? 24 * 60 * 60 * 1000,
  };
  const service = new IdentityService(new IdentityStore(options.database, policy));
  const contexts = new WeakMap<FastifyRequest, OwnerContext>();

  const requireOwner = async (request: FastifyRequest): Promise<void> => {
    const token = readCookie(request, sessionCookieName);
    if (token === undefined) throw unauthorized();
    const session = await service.authenticate(token);
    if (session === undefined) throw unauthorized();
    contexts.set(request, { owner: session.owner, sessionId: session.id });
  };

  const ownerForRequest = (request: FastifyRequest): OwnerContext => {
    const context = contexts.get(request);
    if (context === undefined) throw new Error('Owner context requested before authentication');
    return context;
  };

  application.get('/api/v1/session', async (request, reply) => {
    const token = readCookie(request, sessionCookieName);
    if (token !== undefined) {
      const session = await service.authenticate(token);
      if (session !== undefined) {
        contexts.set(request, { owner: session.owner, sessionId: session.id });
        return {
          authenticated: true,
          setupRequired: false,
          owner: session.owner,
          csrfToken: deriveCsrfToken(token, options.csrfKey),
          expiresAt: session.expiresAt.toISOString(),
        };
      }
      clearHttpOnlyCookie(reply, sessionCookieName, options.cookie);
    }

    const preAuthToken = newOpaqueToken();
    setHttpOnlyCookie(
      reply,
      preAuthCookieName,
      preAuthToken,
      new Date(Date.now() + preAuthLifetimeMs),
      options.cookie,
    );
    return {
      authenticated: false,
      setupRequired: await service.isSetupRequired(),
      csrfToken: deriveCsrfToken(preAuthToken, options.csrfKey),
    };
  });

  application.post('/api/v1/session/setup', async (request, reply) => {
    const body = credentialsFrom(request);
    try {
      const session = await service.setup(body.username, body.password);
      establishSession(reply, session, options);
      return sessionResponse(session, options.csrfKey);
    } catch (error) {
      if (error instanceof SetupAlreadyCompletedError) {
        throw new HttpError(409, 'setup_already_completed', 'Initial setup is already complete');
      }
      if (error instanceof TypeError) {
        throw new HttpError(400, 'credentials_invalid', 'Username or password is invalid');
      }
      throw error;
    }
  });

  application.post('/api/v1/session', async (request, reply) => {
    const body = credentialsFrom(request);
    try {
      const session = await service.login(body.username, body.password);
      establishSession(reply, session, options);
      return sessionResponse(session, options.csrfKey);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) throw unauthorized();
      throw error;
    }
  });

  application.delete('/api/v1/session', { preHandler: requireOwner }, async (request, reply) => {
    const token = readCookie(request, sessionCookieName);
    if (token !== undefined) await service.revoke(token);
    clearHttpOnlyCookie(reply, sessionCookieName, options.cookie);
    reply.status(204).send();
  });

  return {
    service,
    secrets: new SecretVault(options.masterKey),
    requireOwner,
    ownerForRequest,
  };
}

function credentialsFrom(request: FastifyRequest): { username: string; password: string } {
  const body = request.body;
  if (typeof body !== 'object' || body === null) throw invalidCredentialsRequest();
  const { username, password } = body as { username?: unknown; password?: unknown };
  if (
    typeof username !== 'string' ||
    username.trim().length < 1 ||
    username.trim().length > 100 ||
    typeof password !== 'string' ||
    password.length > 1024
  ) {
    throw invalidCredentialsRequest();
  }
  return { username, password };
}

function establishSession(
  reply: FastifyReply,
  session: IssuedSession,
  options: IdentityFeatureOptions,
): void {
  setHttpOnlyCookie(reply, sessionCookieName, session.token, session.expiresAt, options.cookie);
  clearHttpOnlyCookie(reply, preAuthCookieName, options.cookie);
}

function sessionResponse(session: IssuedSession, csrfKey: Buffer) {
  return {
    authenticated: true,
    setupRequired: false,
    owner: session.owner,
    csrfToken: deriveCsrfToken(session.token, csrfKey),
    expiresAt: session.expiresAt.toISOString(),
  };
}

function unauthorized(): HttpError {
  return new HttpError(401, 'authentication_required', 'Authentication is required');
}

function invalidCredentialsRequest(): HttpError {
  return new HttpError(400, 'credentials_invalid', 'Username or password is invalid');
}

function assertKey(key: Buffer, name: string): void {
  if (key.length !== 32) throw new TypeError(`${name} must be 32 bytes`);
}
