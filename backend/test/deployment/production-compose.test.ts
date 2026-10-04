import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const composeFile = join(process.cwd(), '..', 'deploy', 'production', 'compose.yaml');
const digest = `sha256:${'a'.repeat(64)}`;

function environment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    YUKI_BACKEND_IMAGE: `ghcr.io/dexpota/yuki-backend@${digest}`,
    YUKI_WEB_IMAGE: `ghcr.io/dexpota/yuki-web@${digest}`,
    YUKI_PROCESSOR_IMAGE: `ghcr.io/dexpota/yuki-processor@${digest}`,
    YUKI_SUPERVISOR_IMAGE: `ghcr.io/dexpota/yuki-supervisor@${digest}`,
    YUKI_RELEASE_VERSION: '1.2.3',
    YUKI_RELEASE_REVISION: 'b'.repeat(40),
    YUKI_POSTGRES_PASSWORD: 'private-password',
    YUKI_DATABASE_URL: 'postgresql://yuki:private-password@postgres:5432/yuki',
    YUKI_CSRF_KEY: Buffer.alloc(32, 1).toString('base64'),
    YUKI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64'),
    YUKI_PROCESSOR_TOKEN: 'private-processor-token-longer-than-32-bytes',
    YUKI_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
    YUKI_PROCESSOR_WORKSPACE_VOLUME: 'yuki_production_test_jobs',
  };
}

interface ComposeService {
  readonly build?: unknown;
  readonly image?: string;
  readonly volumes?: readonly { readonly source?: string }[];
  readonly depends_on?: Record<string, { readonly condition: string }>;
  readonly environment?: Record<string, string>;
  readonly ports?: readonly unknown[];
}

interface ComposeModel {
  readonly services: Record<string, ComposeService>;
}

async function model(env: NodeJS.ProcessEnv): Promise<ComposeModel> {
  const result = await execute(
    'docker',
    ['compose', '--file', composeFile, '--profile', 'maintenance', 'config', '--format', 'json'],
    {
      env,
    },
  );
  return JSON.parse(result.stdout) as ComposeModel;
}

describe('production Compose model', () => {
  it('uses four selected release images and keeps Docker access in the supervisor', async () => {
    const config = await model(environment());
    for (const service of Object.values(config.services)) expect(service.build).toBeUndefined();
    expect(config.services.api?.image).toBe(config.services.migrate?.image);
    expect(config.services.api?.image).toBe(config.services.worker?.image);
    expect(config.services.api?.image).toBe(config.services.maintenance?.image);
    expect(config.services.supervisor?.image).toContain('yuki-supervisor@sha256:');
    expect(config.services['processor-image']?.image).toContain('yuki-processor@sha256:');
    expect(config.services.supervisor?.volumes).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: '/var/run/docker.sock' })]),
    );
    for (const name of ['api', 'worker', 'migrate', 'maintenance', 'processor-image'])
      expect(JSON.stringify(config.services[name]?.volumes ?? [])).not.toContain('docker.sock');
    expect(config.services.api?.depends_on?.migrate?.condition).toBe(
      'service_completed_successfully',
    );
    expect(config.services.worker?.depends_on?.supervisor?.condition).toBe('service_healthy');
    expect(config.services.postgres?.depends_on?.preflight?.condition).toBe(
      'service_completed_successfully',
    );
    expect(config.services.worker?.environment?.YUKI_PROCESSOR_SOCKET).toBe(
      '/run/yuki/processor.sock',
    );
    expect(config.services.api?.ports).toBeUndefined();
    expect(config.services.worker?.ports).toBeUndefined();
    expect(config.services.web?.ports).toHaveLength(1);
    expect(config.services.web?.depends_on?.api?.condition).toBe('service_healthy');
  });

  it('refuses missing required secrets', async () => {
    const env = environment();
    delete env.YUKI_MASTER_KEY;
    await expect(model(env)).rejects.toThrow('YUKI_MASTER_KEY');
  });
});
