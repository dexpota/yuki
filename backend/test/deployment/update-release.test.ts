// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Shell expansions are embedded in the mock executable string.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const repositoryRoot = join(process.cwd(), '..');
const updater = join(repositoryRoot, 'deploy', 'update-release.sh');
const temporaryDirectories: string[] = [];
const revision = 'a'.repeat(40);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('production release updater', () => {
  it('backs up before atomically selecting, migrating, and checking the new release', async () => {
    const fixture = await createFixture();
    const result = await runUpdater(fixture);

    expect(result.stdout).toContain('Migrations completed for 1.2.3.');
    expect(result.stdout).toContain('Readiness and Compose-managed processor operation passed.');
    expect(await readFile(fixture.releaseEnv, 'utf8')).toContain('YUKI_RELEASE_VERSION=1.2.3');
    expect(await readFile(fixture.previousEnv, 'utf8')).toContain('YUKI_RELEASE_VERSION=0.2.1');
    expect(await readFile(fixture.backup, 'utf8')).toBe('verified backup package');

    const calls = await readFile(fixture.calls, 'utf8');
    expect(calls.indexOf('maintenance create')).toBeLessThan(
      calls.indexOf('stop --timeout 120 web api worker'),
    );
    expect(calls.indexOf('maintenance verify')).toBeLessThan(
      calls.indexOf('stop --timeout 120 web api worker'),
    );
    expect(calls).toContain('run --rm --no-deps migrate');
    expect(calls).toContain('up --detach --wait --no-deps supervisor');
    expect(calls).toContain('up --detach --wait --no-deps api worker');
    expect(calls).toContain('up --detach --wait --no-deps web');
    expect(calls.match(/run --rm --no-deps migrate/g)).toHaveLength(1);
    expect(calls).toContain('node --input-type=module --eval');
    expect(calls).toContain(`--file ${fixture.overlay}`);
  });

  it('leaves the selected release and running services untouched when image retrieval fails', async () => {
    const fixture = await createFixture();

    await expect(runUpdater(fixture, { MOCK_FAIL_PULL: '1' })).rejects.toMatchObject({
      code: 1,
    });

    expect(await readFile(fixture.releaseEnv, 'utf8')).toContain('YUKI_RELEASE_VERSION=0.2.1');
    await expect(readFile(fixture.backup, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const calls = await readFile(fixture.calls, 'utf8');
    expect(calls).not.toContain('maintenance create');
    expect(calls).not.toContain('stop --timeout 120 web api worker');
  });

  it('leaves the verified backup and prior selection available when migration fails', async () => {
    const fixture = await createFixture();

    await expect(runUpdater(fixture, { MOCK_FAIL_MIGRATION: '1' })).rejects.toMatchObject({
      code: 1,
    });

    expect(await readFile(fixture.releaseEnv, 'utf8')).toContain('YUKI_RELEASE_VERSION=1.2.3');
    expect(await readFile(fixture.previousEnv, 'utf8')).toContain('YUKI_RELEASE_VERSION=0.2.1');
    expect(await readFile(fixture.backup, 'utf8')).toBe('verified backup package');
    const calls = await readFile(fixture.calls, 'utf8');
    expect(calls).toContain('stop --timeout 30 web api worker supervisor');
  });

  it('rejects a concurrent update lock before starting any Compose operation', async () => {
    const fixture = await createFixture();
    await mkdir(`${fixture.releaseEnv}.update-lock`);

    await expect(runUpdater(fixture)).rejects.toMatchObject({ code: 1 });

    expect(await readFile(fixture.releaseEnv, 'utf8')).toContain('YUKI_RELEASE_VERSION=0.2.1');
    await expect(readFile(fixture.backup, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function createFixture(): Promise<{
  directory: string;
  manifest: string;
  productionEnv: string;
  releaseEnv: string;
  previousEnv: string;
  backup: string;
  calls: string;
  dockerBin: string;
  overlay: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'yuki-update-release-'));
  temporaryDirectories.push(directory);
  const dockerBin = join(directory, 'bin');
  const backupDirectory = join(directory, 'backups');
  await Promise.all([mkdir(dockerBin), mkdir(backupDirectory)]);
  const manifest = join(directory, 'release-images.json');
  const productionEnv = join(directory, '.env.production');
  const releaseEnv = join(directory, '.env.release');
  const previousEnv = `${releaseEnv}.previous`;
  const backup = join(backupDirectory, 'before.yuki-backup');
  const calls = join(directory, 'docker-calls.log');
  const overlay = join(directory, 'acceptance-overlay.yaml');
  const releaseValues = [
    'YUKI_RELEASE_VERSION=0.2.1',
    `YUKI_RELEASE_REVISION=${revision}`,
    'YUKI_BACKEND_IMAGE=ghcr.io/dexpota/yuki-backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'YUKI_WEB_IMAGE=ghcr.io/dexpota/yuki-web@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'YUKI_PROCESSOR_IMAGE=ghcr.io/dexpota/yuki-processor@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    'YUKI_SUPERVISOR_IMAGE=ghcr.io/dexpota/yuki-supervisor@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  ].join('\n');

  await Promise.all([
    writeFile(manifest, '{}\n'),
    writeFile(productionEnv, 'YUKI_POSTGRES_PASSWORD=secret-for-test\n'),
    writeFile(releaseEnv, `${releaseValues}\n`),
    writeFile(overlay, 'services: {}\n'),
    writeFile(join(dockerBin, 'docker'), fakeDockerScript()),
  ]);
  await chmod(join(dockerBin, 'docker'), 0o755);
  return {
    directory,
    manifest,
    productionEnv,
    releaseEnv,
    previousEnv,
    backup,
    calls,
    dockerBin,
    overlay,
  };
}

async function runUpdater(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  overrides: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return execute('/bin/sh', [updater, fixture.manifest, '1.2.3', fixture.backup], {
    env: {
      ...process.env,
      PATH: `${fixture.dockerBin}:${process.env.PATH}`,
      YUKI_COMPOSE_FILE: join(repositoryRoot, 'deploy/production/compose.yaml'),
      YUKI_COMPOSE_OVERLAY_FILE: fixture.overlay,
      YUKI_COMPOSE_ENV_FILE: fixture.productionEnv,
      YUKI_COMPOSE_RELEASE_ENV_FILE: fixture.releaseEnv,
      YUKI_COMPOSE_PROJECT_NAME: 'production',
      YUKI_UPDATE_NODE_IMAGE: 'node:mock',
      YUKI_UPDATE_MIN_FREE_KB: '1',
      MOCK_DOCKER_CALLS: fixture.calls,
      MOCK_DOCKER_ROOT: fixture.directory,
      ...overrides,
    },
  });
}

function fakeDockerScript(): string {
  return `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$MOCK_DOCKER_CALLS"
if [ "${'${1:-}'}" = info ]; then
  if [ "${'${2:-}'}" = --format ]; then
    case "${'${3:-}'}" in
      *DockerRootDir*) echo "$MOCK_DOCKER_ROOT" ;;
      *) echo linux/amd64 ;;
    esac
  fi
  exit 0
fi
if [ "${'${1:-}'}" = pull ] && [ "${'${MOCK_FAIL_PULL:-}'}" = 1 ]; then exit 1; fi
if [ "${'${1:-}'}" = image ] && [ "${'${2:-}'}" = inspect ]; then
  format=${'${4:-}'}
  case "$format" in
    *version*) echo 1.2.3 ;;
    *revision*) echo ${revision} ;;
    *source*) echo https://github.com/dexpota/yuki ;;
  esac
  exit 0
fi
if [ "${'${1:-}'}" = run ]; then
  for arg in "$@"; do
    case "$arg" in
      type=bind,source=*,target=/candidate)
        candidate_dir=${'${arg#type=bind,source=}'}
        candidate_dir=${'${candidate_dir%,target=/candidate}'}
        cat > "$candidate_dir/candidate.env" <<'ENV'
YUKI_RELEASE_VERSION=1.2.3
YUKI_RELEASE_REVISION=${revision}
YUKI_BACKEND_IMAGE=ghcr.io/dexpota/yuki-backend@sha256:1111111111111111111111111111111111111111111111111111111111111111
YUKI_WEB_IMAGE=ghcr.io/dexpota/yuki-web@sha256:2222222222222222222222222222222222222222222222222222222222222222
YUKI_PROCESSOR_IMAGE=ghcr.io/dexpota/yuki-processor@sha256:3333333333333333333333333333333333333333333333333333333333333333
YUKI_SUPERVISOR_IMAGE=ghcr.io/dexpota/yuki-supervisor@sha256:4444444444444444444444444444444444444444444444444444444444444444
ENV
        exit 0
        ;;
    esac
  done
  exit 0
fi
if [ "${'${1:-}'}" = compose ]; then
  shift
  case "$*" in
    *" version"|version) exit 0 ;;
    *"ps --status running --services"*) printf 'postgres\\napi\\nworker\\nweb\\nsupervisor\\n' ;;
    *"exec -T postgres sh -c"*) printf 'postgres dump bytes' ;;
    *"run --rm --no-deps"*"maintenance create"*) printf 'verified backup package' ;;
    *"run --rm --no-deps migrate"*) [ "${'${MOCK_FAIL_MIGRATION:-}'}" != 1 ] ;;
    *) exit 0 ;;
  esac
fi
exit 0
`;
}
