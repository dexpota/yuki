import { describe, expect, it } from 'vitest';

import { retryDelayMs } from '../../src/platform/jobs/index.js';

describe('job retry backoff', () => {
  it('grows exponentially and remains bounded', () => {
    const policy = { baseDelayMs: 1_000, maximumDelayMs: 5_000 };

    expect([1, 2, 3, 4, 30].map((attempt) => retryDelayMs(attempt, policy))).toEqual([
      1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
  });

  it('rejects invalid attempts and policies', () => {
    expect(() => retryDelayMs(0, { baseDelayMs: 1, maximumDelayMs: 1 })).toThrow(RangeError);
    expect(() => retryDelayMs(1, { baseDelayMs: 0, maximumDelayMs: 1 })).toThrow(RangeError);
    expect(() => retryDelayMs(1, { baseDelayMs: 2, maximumDelayMs: 1 })).toThrow(RangeError);
  });
});
