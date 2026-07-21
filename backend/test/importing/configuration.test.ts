import { describe, expect, it } from 'vitest';

import { readLocalImportConfiguration } from '../../src/importing/index.js';

describe('local import configuration', () => {
  it('uses documented resource and worker defaults', () => {
    const issues: string[] = [];
    expect(readLocalImportConfiguration({ YUKI_STORAGE_ROOT: '/data/yuki' }, issues)).toEqual({
      storageRoot: '/data/yuki',
      maximumUploadBytes: 2 * 1024 * 1024 * 1024,
      progressIntervalBytes: 1024 * 1024,
      workerPollingIntervalMs: 1_000,
      jobLeaseDurationMs: 30_000,
    });
    expect(issues).toEqual([]);
  });

  it('reports missing storage and invalid positive integer settings together', () => {
    const issues: string[] = [];
    readLocalImportConfiguration(
      {
        YUKI_MAXIMUM_UPLOAD_BYTES: '0',
        YUKI_UPLOAD_PROGRESS_INTERVAL_BYTES: 'many',
        YUKI_IMPORT_POLL_INTERVAL_MS: '-1',
        YUKI_IMPORT_JOB_LEASE_MS: '9007199254740992',
      },
      issues,
    );
    expect(issues).toEqual([
      'YUKI_STORAGE_ROOT is required',
      'YUKI_MAXIMUM_UPLOAD_BYTES must be a positive safe integer',
      'YUKI_UPLOAD_PROGRESS_INTERVAL_BYTES must be a positive safe integer',
      'YUKI_IMPORT_POLL_INTERVAL_MS must be a positive safe integer',
      'YUKI_IMPORT_JOB_LEASE_MS must be a positive safe integer',
    ]);
  });
});
