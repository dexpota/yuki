import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const entry = join(process.cwd(), 'src', 'platform', 'deployment', 'production-preflight-main.ts');
const digest = `sha256:${'a'.repeat(64)}`;

function environment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    YUKI_VERSION: '1.2.3',
    YUKI_SOURCE_REVISION: 'b'.repeat(40),
    YUKI_RELEASE_VERSION: '1.2.3',
    YUKI_RELEASE_REVISION: 'b'.repeat(40),
    YUKI_BACKEND_IMAGE: `ghcr.io/dexpota/yuki-backend@${digest}`,
    YUKI_WEB_IMAGE: `ghcr.io/dexpota/yuki-web@${digest}`,
    YUKI_PROCESSOR_IMAGE: `ghcr.io/dexpota/yuki-processor@${digest}`,
    YUKI_SUPERVISOR_IMAGE: `ghcr.io/dexpota/yuki-supervisor@${digest}`,
    YUKI_POSTGRES_PASSWORD: 'a-private-database-password',
    YUKI_DATABASE_URL: 'postgresql://yuki:a-private-database-password@postgres:5432/yuki',
    YUKI_CSRF_KEY: Buffer.alloc(32, 1).toString('base64'),
    YUKI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64'),
    YUKI_PROCESSOR_TOKEN: 'a-private-processor-token-with-more-than-32-bytes',
    YUKI_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
    YUKI_PROCESSOR_WORKSPACE_VOLUME: 'yuki_test_processor_jobs',
    YUKI_STORAGE_BACKEND: 'local',
  };
}

describe('production Compose preflight', () => {
  it('accepts a complete private configuration', async () => {
    const result = await execute(process.execPath, [entry], { env: environment() });
    expect(result.stdout).toContain('Production configuration accepted.');
  });

  it('rejects a checked-in development secret', async () => {
    const env = environment();
    env.YUKI_MASTER_KEY = 'FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhY=';
    await expect(execute(process.execPath, [entry], { env })).rejects.toThrow(
      'YUKI_MASTER_KEY contains a development value',
    );
  });

  it('requires independent signing and encryption keys', async () => {
    const env = environment();
    env.YUKI_MASTER_KEY = env.YUKI_CSRF_KEY;
    await expect(execute(process.execPath, [entry], { env })).rejects.toThrow(
      'YUKI_CSRF_KEY and YUKI_MASTER_KEY must be independent',
    );
  });

  it('rejects a database URL with different credentials', async () => {
    const env = environment();
    env.YUKI_DATABASE_URL = 'postgresql://yuki:another-password@postgres:5432/yuki';
    await expect(execute(process.execPath, [entry], { env })).rejects.toThrow(
      'YUKI_DATABASE_URL must match',
    );
  });

  it('requires private S3 credentials when selected', async () => {
    const env = environment();
    env.YUKI_STORAGE_BACKEND = 's3';
    delete env.YUKI_S3_SECRET_ACCESS_KEY;
    await expect(execute(process.execPath, [entry], { env })).rejects.toThrow(
      'YUKI_S3_ENDPOINT is required',
    );
  });
});
