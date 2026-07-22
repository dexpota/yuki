import { describe, expect, it } from 'vitest';

import { mayStartArtifact, sanitizedCompletion } from '../../../src/catalogue/previews/index.js';

describe('preview artifact workflow', () => {
  it('allows restart of stale processing and failed work but preserves terminal output', () => {
    expect(mayStartArtifact('queued')).toBe(true);
    expect(mayStartArtifact('processing')).toBe(true);
    expect(mayStartArtifact('failed')).toBe(true);
    expect(mayStartArtifact('ready')).toBe(false);
    expect(mayStartArtifact('unsupported')).toBe(false);
  });

  it('sanitizes processor failures before persistence', () => {
    expect(
      sanitizedCompletion({
        status: 'failed',
        code: 'bad/path!',
        message: 'parser\n/private/path',
      }),
    ).toEqual({ status: 'failed', code: 'bad_path_', message: 'parser /private/path' });
  });
});
