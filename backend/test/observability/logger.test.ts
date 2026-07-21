import { describe, expect, it } from 'vitest';

import { createJsonLogger } from '../../src/platform/observability/logger.js';

describe('JSON logger', () => {
  it('emits machine-readable correlated logs and redacts nested secrets', () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      service: 'test-service',
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      write: (line) => lines.push(line),
    });

    logger.child({ requestId: 'request-1', operationId: 'operation-1' }).info('upload_received', {
      cookie: 'session=abc',
      nested: { apiKey: 'abc', safe: 'visible' },
      url: 'https://storage.test/file?signature=secret&part=1',
      authorizationHeader: 'Bearer credential',
    });

    expect(JSON.parse(lines[0] ?? '')).toEqual({
      timestamp: '2026-01-02T03:04:05.000Z',
      level: 'info',
      service: 'test-service',
      event: 'upload_received',
      requestId: 'request-1',
      operationId: 'operation-1',
      cookie: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', safe: 'visible' },
      url: 'https://storage.test/file?signature=[REDACTED]&part=1',
      authorizationHeader: '[REDACTED]',
    });
  });

  it('supports job correlation without logging below the configured level', () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      service: 'worker',
      minimumLevel: 'warn',
      write: (line) => lines.push(line),
    }).child({ jobId: 'job-1' });

    logger.info('job_started');
    logger.warn('job_delayed');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ event: 'job_delayed', jobId: 'job-1' });
  });
});
