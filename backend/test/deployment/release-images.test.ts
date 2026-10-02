import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const repositoryRoot = join(process.cwd(), '..');
const generator = join(repositoryRoot, 'deploy', 'generate-release-images.mjs');
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('release image manifest generator', () => {
  it('records exact tags, index digests, and both supported platform digests', async () => {
    const directory = await fixtureDirectory();
    await execute(process.execPath, [generator], { env: environment(directory) });

    const manifest = JSON.parse(await readFile(join(directory, 'release-images.json'), 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      release: {
        version: '1.2.3',
        tag: 'v1.2.3',
        sourceRevision: 'a'.repeat(40),
      },
      images: {
        backend: {
          tag: 'ghcr.io/dexpota/yuki-backend:1.2.3',
          reference: `ghcr.io/dexpota/yuki-backend@${digest('b')}`,
          digest: digest('b'),
          platforms: [
            { os: 'linux', architecture: 'amd64', digest: digest('c') },
            { os: 'linux', architecture: 'arm64', digest: digest('d') },
          ],
        },
      },
    });
  });

  it('rejects an index that omits a supported platform', async () => {
    const directory = await fixtureDirectory();
    await writeFile(
      join(directory, 'processor.json'),
      JSON.stringify({
        manifests: [{ digest: digest('c'), platform: { os: 'linux', architecture: 'amd64' } }],
      }),
    );

    await expect(
      execute(process.execPath, [generator], { env: environment(directory) }),
    ).rejects.toThrow("processor platforms are 'amd64', expected 'amd64,arm64'.");
  });
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yuki-release-images-'));
  temporaryDirectories.push(directory);
  const index = {
    manifests: [
      { digest: digest('d'), platform: { os: 'linux', architecture: 'arm64' } },
      { digest: digest('e'), platform: { os: 'unknown', architecture: 'unknown' } },
      { digest: digest('c'), platform: { os: 'linux', architecture: 'amd64' } },
    ],
  };
  await Promise.all(
    ['backend', 'web', 'processor'].map((name) =>
      writeFile(join(directory, `${name}.json`), JSON.stringify(index)),
    ),
  );
  return directory;
}

function environment(directory: string): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {
    ...process.env,
    YUKI_RELEASE_VERSION: '1.2.3',
    YUKI_RELEASE_TAG: 'v1.2.3',
    YUKI_SOURCE_REVISION: 'a'.repeat(40),
    YUKI_SOURCE_REPOSITORY: 'https://github.com/dexpota/yuki',
    YUKI_RELEASE_CREATED_AT: '2026-09-28T12:00:00Z',
    YUKI_RELEASE_IMAGES_OUTPUT: join(directory, 'release-images.json'),
  };
  for (const [index, name] of ['backend', 'web', 'processor'].entries()) {
    const prefix = `YUKI_${name.toUpperCase()}`;
    values[`${prefix}_TAG`] = `ghcr.io/dexpota/yuki-${name}:1.2.3`;
    values[`${prefix}_REFERENCE`] = `ghcr.io/dexpota/yuki-${name}@${digest(
      String.fromCharCode('b'.charCodeAt(0) + index),
    )}`;
    values[`${prefix}_INDEX_FILE`] = join(directory, `${name}.json`);
  }
  return values;
}
