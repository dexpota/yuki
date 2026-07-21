import { describe, expect, it } from 'vitest';

import { apiArtifact, runApi } from '../src/api-main.js';
import type { IdentityDatabaseSchema } from '../src/identity/index.js';
import type { Database } from '../src/platform/database/index.js';
import { runWorker, workerArtifact } from '../src/worker-main.js';

describe('backend entry points', () => {
  it('starts and cleanly stops the API after a termination signal', async () => {
    const status: string[] = [];
    const exitCode = await runApi({
      environment: validApiEnvironment(),
      createDatabase: () => ({}) as Database<IdentityDatabaseSchema>,
      closeDatabase: async () => {},
      waitForShutdown: async () => 'SIGTERM',
      writeStatus: (message) => status.push(message),
    });

    expect(exitCode).toBe(0);
    expect(status).toEqual([
      'backend-api started',
      'backend-api stopping (SIGTERM)',
      'backend-api stopped',
    ]);
  });

  it('starts and cleanly stops the worker after an interrupt signal', async () => {
    const status: string[] = [];
    const exitCode = await runWorker({
      environment: { NODE_ENV: 'test' },
      waitForShutdown: async () => 'SIGINT',
      writeStatus: (message) => status.push(message),
    });

    expect(exitCode).toBe(0);
    expect(status).toEqual([
      'backend-worker started',
      'backend-worker stopping (SIGINT)',
      'backend-worker stopped',
    ]);
  });

  it('fails before startup when configuration is invalid', async () => {
    const errors: string[] = [];
    let waited = false;
    const exitCode = await runApi({
      environment: { YUKI_API_PORT: '0' },
      waitForShutdown: async () => {
        waited = true;
        return 'SIGTERM';
      },
      writeError: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(waited).toBe(false);
    expect(errors).toEqual([
      'backend-api configuration error: YUKI_API_PORT must be an integer between 1 and 65535',
    ]);
  });

  it('keeps stable artifact names for deployment commands', () => {
    expect([apiArtifact, workerArtifact]).toEqual(['backend-api', 'backend-worker']);
  });
});

function validApiEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    YUKI_DATABASE_URL: 'postgresql://unused/test',
    YUKI_CSRF_KEY: Buffer.alloc(32, 1).toString('base64'),
    YUKI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64'),
    YUKI_ALLOWED_ORIGINS: 'https://yuki.local',
  };
}
