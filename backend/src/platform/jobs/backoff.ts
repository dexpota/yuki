import type { RetryPolicy } from './types.js';

export function retryDelayMs(attempt: number, policy: RetryPolicy): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError('attempt must be a positive integer');
  }
  if (!Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs < 1) {
    throw new RangeError('baseDelayMs must be a positive integer');
  }
  if (!Number.isSafeInteger(policy.maximumDelayMs) || policy.maximumDelayMs < policy.baseDelayMs) {
    throw new RangeError('maximumDelayMs must be at least baseDelayMs');
  }

  const exponent = Math.min(attempt - 1, 30);
  return Math.min(policy.maximumDelayMs, policy.baseDelayMs * 2 ** exponent);
}
