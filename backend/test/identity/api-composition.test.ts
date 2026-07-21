import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiApplication, readApiCompositionConfiguration } from '../../src/api-main.js';
import type { IdentityDatabaseSchema } from '../../src/identity/index.js';
import { closeDatabase, createDatabase, type Database } from '../../src/platform/database/index.js';
import { HealthRegistry } from '../../src/platform/observability/health.js';
import { createJsonLogger } from '../../src/platform/observability/logger.js';

describe('API composition configuration', () => {
  it('fails startup when identity, database, or allowed-origin configuration is missing', () => {
    expect(() => readApiCompositionConfiguration({ NODE_ENV: 'production' })).toThrow(
      /YUKI_DATABASE_URL is required.*YUKI_CSRF_KEY is required.*YUKI_ALLOWED_ORIGINS is required/,
    );
  });

  it('rejects URLs that are not exact HTTP origins', () => {
    expect(() =>
      readApiCompositionConfiguration({
        ...validEnvironment(),
        YUKI_ALLOWED_ORIGINS: 'https://yuki.local/path',
      }),
    ).toThrow('YUKI_ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins');
  });
});

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('identity API composition with PostgreSQL', () => {
  let database: Database<IdentityDatabaseSchema>;
  const schemaName = `i01_composition_${process.pid}_${Date.now()}`;

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
    const cleanup = createDatabase<IdentityDatabaseSchema>(configuration(databaseUrl as string));
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('exposes identity with CSRF, protects metrics, reports DB readiness, and closes DB', async () => {
    const health = new HealthRegistry();
    const configuration = readApiCompositionConfiguration(validEnvironment());
    const application = await createApiApplication(
      createJsonLogger({ service: 'composition-test', write: () => {} }),
      health,
      database,
      configuration,
    );
    health.setAcceptingWork(true);

    const readiness = await application.inject({ method: 'GET', url: '/health/ready' });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json().checks.database).toBe('up');

    const initial = await application.inject({ method: 'GET', url: '/api/v1/session' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().setupRequired).toBe(true);
    const preAuth = cookiePair(initial.headers['set-cookie'], 'yuki_pre_auth');

    const csrfRejected = await application.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      headers: { origin: 'https://yuki.local', cookie: preAuth },
      payload: { username: 'Owner', password: 'correct horse battery staple' },
    });
    expect(csrfRejected.statusCode).toBe(403);
    expect(csrfRejected.json().error.code).toBe('csrf_token_invalid');

    const setup = await application.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      headers: {
        origin: 'https://yuki.local',
        cookie: preAuth,
        'x-csrf-token': initial.json().csrfToken,
      },
      payload: { username: 'Owner', password: 'correct horse battery staple' },
    });
    expect(setup.statusCode).toBe(200);
    const session = cookiePair(setup.headers['set-cookie'], 'yuki_session');

    const denied = await application.inject({ method: 'GET', url: '/diagnostics/metrics' });
    const allowed = await application.inject({
      method: 'GET',
      url: '/diagnostics/metrics',
      headers: { cookie: session },
    });
    expect(denied.statusCode).toBe(401);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toContain('yuki_http_requests_total');

    await application.close();
    await expect(sql`select 1`.execute(database)).rejects.toThrow();
  });
});

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    YUKI_DATABASE_URL: databaseUrl ?? 'postgresql://unused/test',
    YUKI_CSRF_KEY: Buffer.alloc(32, 1).toString('base64'),
    YUKI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64'),
    YUKI_ALLOWED_ORIGINS: 'https://yuki.local',
  };
}

function configuration(connectionString: string) {
  return {
    connectionString,
    maximumPoolSize: 4,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: 20_000,
    applicationName: 'i01-composition-test',
  };
}

function cookiePair(header: string | string[] | undefined, name: string): string {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (cookie === undefined) throw new Error(`Missing ${name} cookie`);
  return cookie.split(';', 1)[0] as string;
}
