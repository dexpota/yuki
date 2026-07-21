import { describe, expect, it } from 'vitest';

import { frontendArtifact } from '../src/artifact.js';

describe('frontend artifact', () => {
  it('is available to the workspace toolchain', () => {
    expect(frontendArtifact).toBe('frontend');
  });
});
