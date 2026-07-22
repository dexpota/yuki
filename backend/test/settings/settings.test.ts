import { readFile } from 'node:fs/promises';

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closeDatabase, createDatabase, type Database } from '../../src/platform/database/index.js';
import { createHttpApplication, HttpError } from '../../src/platform/http/index.js';
import {
  InstallationSettingsService,
  registerSettingsFeature,
  SettingsConflictError,
  type SettingsDatabaseSchema,
} from '../../src/settings/index.js';

describe('settings authentication boundary', () => {
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;
  afterEach(async () => application?.close());
  it('does not resolve an owner before authentication', async () => {
    application = await createHttpApplication();
    registerSettingsFeature(application, {
      database: {} as Kysely<SettingsDatabaseSchema>,
      identity: {
        requireOwner: async () => {
          throw new HttpError(401, 'authentication_required', 'Authentication is required');
        },
        ownerForRequest: () => {
          throw new Error('owner must remain unavailable');
        },
      },
    });
    expect(
      (await application.inject({ method: 'GET', url: '/api/v1/settings/installation' }))
        .statusCode,
    ).toBe(401);
  });
});

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration('owner-scoped installation settings', () => {
  let database: Database<SettingsDatabaseSchema>;
  const schema = `s01_${process.pid}_${Date.now()}`;
  const ownerOne = '10000000-0000-4000-8000-000000000001';
  const ownerTwo = '10000000-0000-4000-8000-000000000002';
  beforeAll(async () => {
    const setup = createDatabase<SettingsDatabaseSchema>(
      configuration(databaseUrl as string, 's01-setup'),
    );
    await sql.raw(`create schema "${schema}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase<SettingsDatabaseSchema>(configuration(url.toString(), 's01-test'));
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerOne}), (${ownerTwo})`.execute(
      database,
    );
    await sql
      .raw(
        await readFile(new URL('../../migrations/0012_settings.up.sql', import.meta.url), 'utf8'),
      )
      .execute(database);
  });
  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<SettingsDatabaseSchema>(
      configuration(databaseUrl as string, 's01-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });
  it('uses safe defaults, isolates owners, validates, and fences stale writes', async () => {
    const service = new InstallationSettingsService(
      database,
      () => new Date('2026-07-22T12:00:00Z'),
    );
    expect(await service.get(ownerOne)).toMatchObject({
      version: 0,
      authentication: { mode: 'password' },
      notifications: { mode: 'disabled' },
    });
    const saved = await service.update(ownerOne, {
      expectedVersion: 0,
      limits: {
        uploadMaxBytes: 1048576,
        archiveMaxMembers: 50,
        archiveExpandedMaxBytes: 2097152,
        archiveMaxRatio: 20,
      },
    });
    expect(saved.version).toBe(1);
    expect((await service.get(ownerTwo)).version).toBe(0);
    await expect(service.update(ownerOne, { expectedVersion: 0 })).rejects.toBeInstanceOf(
      SettingsConflictError,
    );
    await expect(
      service.update(ownerTwo, {
        expectedVersion: 0,
        retention: { trashDays: 0, jobDays: 1, observationHistoryEntries: 10 },
      }),
    ).rejects.toBeInstanceOf(RangeError);
    const concurrent = await Promise.allSettled([
      service.update(ownerTwo, { expectedVersion: 0 }),
      service.update(ownerTwo, { expectedVersion: 0 }),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toMatch(/"(?:apiKey|password|secret|credential)"\s*:/i);
  });
});

function configuration(connectionString: string, applicationName: string) {
  return {
    connectionString,
    maximumPoolSize: 2,
    connectionTimeoutMs: 5000,
    idleTimeoutMs: 1000,
    statementTimeoutMs: 5000,
    applicationName,
  };
}
