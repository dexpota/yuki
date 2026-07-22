import { readFile } from 'node:fs/promises';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SecretVault } from '../../../src/identity/index.js';
import {
  closeDatabase,
  createDatabase,
  type Database,
} from '../../../src/platform/database/index.js';
import {
  OctoPrintGateway,
  type PrinterDatabaseSchema,
  PrinterDestinationPolicy,
  PrinterNotFoundError,
  PrinterService,
} from '../../../src/printing/printers/public.js';

const databaseUrl = process.env.YUKI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('owner-scoped encrypted printer configuration', () => {
  let database: Database<PrinterDatabaseSchema>;
  const schemaName = `p01_${process.pid}_${Date.now()}`;
  const ownerOne = '10000000-0000-4000-8000-000000000001';
  const ownerTwo = '10000000-0000-4000-8000-000000000002';
  const printerId = '80000000-0000-4000-8000-000000000001';
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ current: { state: 'Operational', version: '1.10.3' } })),
  );

  beforeAll(async () => {
    const setup = createDatabase<PrinterDatabaseSchema>(
      configuration(databaseUrl as string, 'p01-setup'),
    );
    await sql.raw(`create schema "${schemaName}"`).execute(setup);
    await closeDatabase(setup);
    const url = new URL(databaseUrl as string);
    url.searchParams.set('options', `-c search_path=${schemaName}`);
    database = createDatabase<PrinterDatabaseSchema>(configuration(url.toString(), 'p01-test'));
    await sql`create table identity_users (id uuid primary key)`.execute(database);
    await sql`insert into identity_users (id) values (${ownerOne}), (${ownerTwo})`.execute(
      database,
    );
    await applyMigration(database, '0008_printers.up.sql');
  });

  afterAll(async () => {
    if (database) await closeDatabase(database);
    const cleanup = createDatabase<PrinterDatabaseSchema>(
      configuration(databaseUrl as string, 'p01-cleanup'),
    );
    await sql.raw(`drop schema if exists "${schemaName}" cascade`).execute(cleanup);
    await closeDatabase(cleanup);
  });

  it('verifies before create, encrypts the API key, and never exposes secret or URL', async () => {
    const service = createService(database, fetchMock, printerId);
    const created = await service.create(ownerOne, {
      displayName: 'Workshop',
      octoprintUrl: 'http://printer.home.arpa:5000',
      apiKey: 'plaintext-api-key',
      profile: profile(),
    });
    expect(created).toMatchObject({
      id: printerId,
      credentialConfigured: true,
      connectionStatus: 'online',
    });
    expect(created).not.toHaveProperty('apiKey');
    expect(created).not.toHaveProperty('octoprintUrl');

    const stored = await database
      .selectFrom('printers')
      .selectAll()
      .where('id', '=', printerId)
      .executeTakeFirstOrThrow();
    expect(stored.encrypted_api_key).not.toContain('plaintext-api-key');
    expect(stored.encrypted_api_key).not.toBe('plaintext-api-key');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('enforces owner isolation for reads, updates, verification, and deletion', async () => {
    const service = createService(database, fetchMock, printerId);
    await expect(service.get(ownerTwo, printerId)).rejects.toBeInstanceOf(PrinterNotFoundError);
    await expect(
      service.update(ownerTwo, printerId, { displayName: 'Stolen' }),
    ).rejects.toBeInstanceOf(PrinterNotFoundError);
    await expect(service.verifySaved(ownerTwo, printerId)).rejects.toBeInstanceOf(
      PrinterNotFoundError,
    );
    await expect(service.remove(ownerTwo, printerId)).rejects.toBeInstanceOf(PrinterNotFoundError);
    await expect(service.get(ownerOne, printerId)).resolves.toMatchObject({
      displayName: 'Workshop',
    });
  });
});

function createService(
  database: Database<PrinterDatabaseSchema>,
  request: typeof fetch,
  printerId: string,
) {
  return new PrinterService(
    database,
    new SecretVault(Buffer.alloc(32, 7)),
    new PrinterDestinationPolicy({ lookupAddresses: async () => ['192.168.1.44'] }),
    new OctoPrintGateway({ fetch: request }),
    { newId: () => printerId, now: () => new Date('2026-07-22T10:00:00Z') },
  );
}

function profile() {
  return {
    buildVolume: {
      shape: 'rectangular' as const,
      origin: 'lowerleft' as const,
      widthMm: 220,
      depthMm: 220,
      heightMm: 250,
    },
    compatibility: { gcodeFlavors: ['marlin'], nozzleDiameterMm: 0.4, extruderCount: 1 },
  };
}

async function applyMigration(database: Database<PrinterDatabaseSchema>, filename: string) {
  const migration = await readFile(
    new URL(`../../../migrations/${filename}`, import.meta.url),
    'utf8',
  );
  await sql.raw(migration).execute(database);
}

function configuration(connectionString: string, applicationName: string) {
  return {
    connectionString,
    maximumPoolSize: 2,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: 5_000,
    applicationName,
  };
}
