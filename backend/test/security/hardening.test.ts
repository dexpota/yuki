import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = join(process.cwd(), '..');

describe('deployment security invariants', () => {
  it('runs application images as unprivileged users with writable data prepared explicitly', async () => {
    const [backend, frontend, processor] = await Promise.all([
      readFile(join(repositoryRoot, 'backend', 'Dockerfile'), 'utf8'),
      readFile(join(repositoryRoot, 'frontend', 'Dockerfile'), 'utf8'),
      readFile(join(repositoryRoot, 'processor', 'Dockerfile'), 'utf8'),
    ]);

    expect(backend).toContain('FROM build AS development');
    expect(backend).toMatch(/FROM node:24\.18\.0-bookworm-slim@sha256:[a-f0-9]{64} AS production/);
    expect(backend).toContain('chown node:node /data/yuki');
    expect(backend).toMatch(/\nUSER node\nCMD \["node", "dist\/api-main\.js"\]\s*$/);
    expect(frontend).toContain('pnpm --filter @yuki/frontend build');
    expect(frontend).toMatch(/FROM caddy:2\.10\.0-alpine@sha256:[a-f0-9]{64} AS production/);
    expect(frontend).toMatch(/\nUSER 65532:65532\nCMD \["caddy", "run"/);
    expect(processor).toContain('chmod -R a=rX /app /licenses');
    expect(processor).toMatch(/\nUSER 65532:65532\nENTRYPOINT /);
    for (const dockerfile of [backend, frontend, processor]) {
      const baseImages = dockerfile.match(/^FROM\s+\S+/gm) ?? [];
      expect(baseImages.length).toBeGreaterThan(0);
      for (const baseImage of baseImages) {
        if (!baseImage.endsWith('build')) expect(baseImage).toMatch(/@sha256:[a-f0-9]{64}$/);
      }
    }
  });

  it('pins release workflow actions and publishes only exact version tags', async () => {
    const workflow = await readFile(
      join(repositoryRoot, '.github', 'workflows', 'release-images.yml'),
      'utf8',
    );
    const uses = workflow.match(/^\s*uses:\s+\S+/gm) ?? [];

    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/@[a-f0-9]{40}(?:\s+#.*)?$/);
    expect(workflow).toContain('^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$');
    expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
    expect(workflow).toContain('provenance: mode=max');
    expect(workflow).toContain('sbom: true');
    expect(workflow).not.toContain(':latest');

    const publish = workflow.match(/\n  publish:[\s\S]*?(?=\n  attach-release-manifest:)/)?.[0];
    const attachment = workflow.match(/\n  attach-release-manifest:[\s\S]*$/)?.[0];
    expect(publish).toContain('contents: read');
    expect(publish).not.toContain('contents: write');
    expect(attachment).toContain('contents: write');
    expect(attachment).not.toContain('packages: write');
  });

  it('keeps application services unprivileged, read-only, and separated from Docker', async () => {
    const compose = await readFile(join(repositoryRoot, 'deploy', 'compose.yaml'), 'utf8');

    expect(compose).not.toMatch(/docker\.sock|privileged:\s*true/);
    for (const name of ['migrate', 'api', 'worker', 'processor-bridge', 'web']) {
      const service = serviceBlock(compose, name);
      expect(service).toContain('no-new-privileges:true');
      expect(service).toMatch(/cap_drop:\s*\n\s+- ALL/);
      expect(service).toContain('read_only: true');
    }
    expect(serviceBlock(compose, 'processor-bridge')).toContain('user: "65532:65532"');
  });
});

function serviceBlock(compose: string, name: string): string {
  const match = compose.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm'),
  );
  if (match === null) throw new Error(`Compose service ${name} was not found`);
  return match[0];
}
