import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIdentityCsrfTokenSource,
  type IdentityDatabaseSchema,
  IdentityStore,
  preAuthCookieName,
  registerIdentityFeature,
  sessionCookieName,
} from '../../src/identity/index.js';
import { closeDatabase, createDatabase, type Database } from '../../src/platform/database/index.js';
import { createHttpApplication } from '../../src/platform/http/index.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('identity PostgreSQL and HTTP integration', () => {
  let database: Database<IdentityDatabaseSchema>;
  const schemaName = `i01_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    const setup = createDatabase<IdentityDatabaseSchema>(configuration(databaseUrl as string));
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);

    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<IdentityDatabaseSchema>(configuration(url.toString()));
    const migration = await readFile(
      resolve(import.meta.dirname, '../../migrations/0003_identity.up.sql'),
      'utf8',
    );
    await sql.raw(migration).execute(database);
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<IdentityDatabaseSchema>(configuration(databaseUrl as string));
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('atomically permits exactly one first user', async () => {
    await clearIdentity();
    const store = new IdentityStore(database, policy());
    const attempts = await Promise.allSettled([
      store.createFirstUser('Owner', 'argon-hash-a'),
      store.createFirstUser('Other', 'argon-hash-b'),
    ]);

    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const count = await database
      .selectFrom('identity_users')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    expect(count.count).toBe('1');
  });

  it('stores only the session-token hash and enforces expiry, revocation, and rotation', async () => {
    await clearIdentity();
    const store = new IdentityStore(database, policy());
    const owner = await store.createFirstUser('Owner', 'argon-hash');
    const issued = await store.issueSession(owner, new Date('2026-01-01T00:00:00Z'));
    const persisted = await database
      .selectFrom('identity_sessions')
      .select(['token_hash', 'expires_at'])
      .executeTakeFirstOrThrow();

    expect(persisted.token_hash).not.toBe(issued.token);
    await expect(
      store.authenticate(issued.token, new Date('2026-01-01T00:00:01Z')),
    ).resolves.toBeDefined();
    const rotated = await store.rotate(issued.token, new Date('2026-01-01T00:00:02Z'));
    expect(rotated?.token).not.toBe(issued.token);
    await expect(
      store.authenticate(issued.token, new Date('2026-01-01T00:00:03Z')),
    ).resolves.toBeUndefined();
    await store.revoke(rotated?.token as string, new Date('2026-01-01T00:00:04Z'));
    await expect(
      store.authenticate(rotated?.token as string, new Date('2026-01-01T00:00:05Z')),
    ).resolves.toBeUndefined();

    const expiring = await store.issueSession(owner, new Date('2026-01-02T00:00:00Z'));
    await expect(
      store.authenticate(expiring.token, new Date('2026-01-09T00:00:00Z')),
    ).resolves.toBeUndefined();
  });

  it('runs setup and Argon2id login through CSRF-protected HTTP sessions', async () => {
    await clearIdentity();
    const csrfKey = Buffer.alloc(32, 1);
    const application = await createHttpApplication({
      csrf: {
        allowedOrigins: ['https://yuki.local'],
        tokenForRequest: createIdentityCsrfTokenSource(csrfKey),
      },
    });
    registerIdentityFeature(application, {
      database,
      csrfKey,
      masterKey: Buffer.alloc(32, 2),
      cookie: { secure: true },
    });

    const initial = await application.inject({ method: 'GET', url: '/api/v1/session' });
    const initialBody = initial.json<{ csrfToken: string; setupRequired: boolean }>();
    const preAuthCookie = cookiePair(initial.headers['set-cookie'], preAuthCookieName);
    expect(initialBody.setupRequired).toBe(true);

    const setup = await application.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      headers: {
        origin: 'https://yuki.local',
        cookie: preAuthCookie,
        'x-csrf-token': initialBody.csrfToken,
      },
      payload: { username: 'Owner', password: 'correct horse battery staple' },
    });
    expect(setup.statusCode).toBe(200);
    expect(setup.body).not.toContain('correct horse');
    expect(cookiePair(setup.headers['set-cookie'], sessionCookieName)).toContain(sessionCookieName);

    const anotherSetup = await application.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      headers: {
        origin: 'https://yuki.local',
        cookie: preAuthCookie,
        'x-csrf-token': initialBody.csrfToken,
      },
      payload: { username: 'Other', password: 'another valid password' },
    });
    expect(anotherSetup.statusCode).toBe(409);

    const loginBootstrap = await application.inject({ method: 'GET', url: '/api/v1/session' });
    const loginBootstrapBody = loginBootstrap.json<{ csrfToken: string }>();
    const login = await application.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: {
        origin: 'https://yuki.local',
        cookie: cookiePair(loginBootstrap.headers['set-cookie'], preAuthCookieName),
        'x-csrf-token': loginBootstrapBody.csrfToken,
      },
      payload: { username: 'owner', password: 'correct horse battery staple' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().owner.username).toBe('Owner');
    await application.close();
  });

  async function clearIdentity(): Promise<void> {
    await sql`truncate identity_users cascade`.execute(database);
  }
});

function policy() {
  return { absoluteLifetimeMs: 7 * 24 * 60 * 60 * 1000, idleLifetimeMs: 24 * 60 * 60 * 1000 };
}

function configuration(connectionString: string) {
  return {
    connectionString,
    maximumPoolSize: 4,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: 20_000,
    applicationName: 'i01-test',
  };
}

function cookiePair(header: string | string[] | undefined, name: string): string {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (cookie === undefined) throw new Error(`Missing ${name} cookie`);
  return cookie.split(';', 1)[0] as string;
}
