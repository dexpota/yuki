import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('production release acceptance gate', () => {
  it('runs candidate installation, restore, and upgrade on both native platforms before attaching assets', async () => {
    const workflow = await readFile(resolve('../.github/workflows/release-images.yml'), 'utf8');
    const runner = await readFile(resolve('../acceptance/run-production-release.sh'), 'utf8');
    const acceptanceCompose = await readFile(
      resolve('../acceptance/production-compose.yaml'),
      'utf8',
    );

    expect(workflow).toContain('types: [prereleased]');
    expect(workflow).toContain('production-acceptance:');
    expect(workflow).toContain('runner: ubuntu-24.04');
    expect(workflow).toContain('runner: ubuntu-24.04-arm');
    expect(workflow).toContain('./acceptance/run-production-release.sh');
    expect(workflow).toContain('needs: [validate, publish, production-acceptance]');
    expect(workflow).toContain('production-acceptance-' + '$' + '{{ matrix.arch }}');

    expect(runner).toContain('deploy/backup.sh');
    expect(runner).toContain('deploy/restore.sh');
    expect(runner).toContain('deploy/update-release.sh');
    expect(runner).toContain('previous_supported=0');
    expect(runner).toContain('first-release migration replay baseline');
    expect(runner).toContain('run_browser_acceptance "$clean_url"');
    expect(runner).toContain('up --detach --wait web worker octoprint-a octoprint-b');
    expect(runner).toContain('run_persistence_check "$restore_url"');
    expect(acceptanceCompose).toContain('internal: true');
  });

  it('ships the one-shot updater and its supervisor smoke helper in the deployment bundle', async () => {
    const workflow = await readFile(resolve('../.github/workflows/release-images.yml'), 'utf8');
    const deploymentDocs = await readFile(resolve('../deploy/PRODUCTION.md'), 'utf8');

    expect(workflow).toContain('deploy/update-release.sh');
    expect(workflow).toContain('deploy/smoke-compose-supervisor.mjs');
    expect(deploymentDocs).toContain('deploy/update-release.sh');
    expect(deploymentDocs).toContain('latest supported release');
  });
});
