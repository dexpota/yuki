import { describe, expect, it } from 'vitest';

import { apiArtifact } from '../src/api-main.js';
import { workerArtifact } from '../src/worker-main.js';

describe('backend artifact', () => {
  it('provides API and worker composition-root placeholders', () => {
    expect([apiArtifact, workerArtifact]).toEqual(['backend-api', 'backend-worker']);
  });
});
