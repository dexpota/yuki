import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadMigrations, MigrationError } from '../../src/platform/database/index.js';

describe('migration files', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true });
  });

  it('loads paired files in numeric global order', async () => {
    directory = await mkdtemp(join(tmpdir(), 'yuki-migrations-'));
    await writeFile(join(directory, '0002_second.up.sql'), 'select 2');
    await writeFile(join(directory, '0002_second.down.sql'), 'select -2');
    await writeFile(join(directory, '0001_first.up.sql'), 'select 1');
    await writeFile(join(directory, '0001_first.down.sql'), 'select -1');

    const migrations = await loadMigrations(directory);

    expect(migrations.map(({ id }) => id)).toEqual(['0001_first', '0002_second']);
    expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects an unpaired migration', async () => {
    directory = await mkdtemp(join(tmpdir(), 'yuki-migrations-'));
    await writeFile(join(directory, '0001_incomplete.up.sql'), 'select 1');

    await expect(loadMigrations(directory)).rejects.toThrowError(MigrationError);
  });

  it('rejects reuse of an ordering prefix', async () => {
    directory = await mkdtemp(join(tmpdir(), 'yuki-migrations-'));
    for (const name of ['first', 'duplicate']) {
      await writeFile(join(directory, `0001_${name}.up.sql`), 'select 1');
      await writeFile(join(directory, `0001_${name}.down.sql`), 'select -1');
    }

    await expect(loadMigrations(directory)).rejects.toThrow('Migration order 0001 is used');
  });
});
