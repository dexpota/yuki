import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = join(process.cwd(), '..');

describe('deployment security invariants', () => {
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
