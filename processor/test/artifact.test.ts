import { describe, expect, it } from 'vitest';

import { processorArtifact } from '../src/artifact.js';

describe('processor artifact', () => {
  it('is available to the workspace toolchain', () => {
    expect(processorArtifact).toBe('processor');
  });
});
