import { describe, expect, it } from 'vitest';

import { MetricsRegistry } from '../../src/platform/observability/metrics.js';

describe('metrics registry', () => {
  it('renders local Prometheus counters', () => {
    const registry = new MetricsRegistry();
    const failures = registry.counter('yuki_jobs_failed_total', 'Failed jobs', {
      kind: ['import', 'preview'],
    });
    failures.increment({ kind: 'import' });
    failures.increment({ kind: 'import' }, 2);

    expect(registry.renderPrometheus()).toContain('yuki_jobs_failed_total{kind="import"} 3');
  });

  it('rejects unbounded or incomplete label values', () => {
    const registry = new MetricsRegistry();
    const jobs = registry.counter('yuki_jobs_total', 'Jobs', { state: ['ready', 'failed'] });

    expect(() => jobs.increment({ state: 'user-provided-id' })).toThrow('rejects label');
    expect(() => jobs.increment()).toThrow('requires exactly');
    expect(() => jobs.increment({ state: 'ready', id: '1' })).toThrow('requires exactly');
  });
});
