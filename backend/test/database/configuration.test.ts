import { describe, expect, it } from 'vitest';

import {
  DatabaseConfigurationError,
  readDatabaseConfiguration,
} from '../../src/platform/database/index.js';

describe('database configuration', () => {
  it('reads a PostgreSQL URL and bounded pool settings', () => {
    expect(
      readDatabaseConfiguration({
        YUKI_DATABASE_URL: 'postgresql://yuki:secret@postgres:5432/yuki',
        YUKI_DATABASE_POOL_MAX: '12',
        YUKI_DATABASE_STATEMENT_TIMEOUT_MS: '45000',
      }),
    ).toEqual({
      connectionString: 'postgresql://yuki:secret@postgres:5432/yuki',
      maximumPoolSize: 12,
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 45_000,
      applicationName: 'yuki',
    });
  });

  it('reports all invalid database settings without exposing a password', () => {
    expect(() =>
      readDatabaseConfiguration({
        YUKI_DATABASE_URL: 'https://user:super-secret@example.test/database',
        YUKI_DATABASE_POOL_MAX: '0',
        YUKI_DATABASE_APPLICATION_NAME: 'invalid name',
      }),
    ).toThrowError(DatabaseConfigurationError);

    try {
      readDatabaseConfiguration({
        YUKI_DATABASE_URL: 'https://user:super-secret@example.test/database',
        YUKI_DATABASE_POOL_MAX: '0',
        YUKI_DATABASE_APPLICATION_NAME: 'invalid name',
      });
    } catch (error) {
      expect(String(error)).not.toContain('super-secret');
      expect(String(error)).toContain('YUKI_DATABASE_POOL_MAX');
      expect(String(error)).toContain('YUKI_DATABASE_APPLICATION_NAME');
    }
  });
});
