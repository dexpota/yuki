export interface LocalImportConfiguration {
  readonly maximumUploadBytes: number;
  readonly progressIntervalBytes: number;
  readonly workerPollingIntervalMs: number;
  readonly jobLeaseDurationMs: number;
}

export function readLocalImportConfiguration(
  environment: NodeJS.ProcessEnv,
  issues: string[],
): LocalImportConfiguration {
  return {
    maximumUploadBytes: readPositiveInteger(
      environment.YUKI_MAXIMUM_UPLOAD_BYTES,
      'YUKI_MAXIMUM_UPLOAD_BYTES',
      2 * 1024 * 1024 * 1024,
      issues,
    ),
    progressIntervalBytes: readPositiveInteger(
      environment.YUKI_UPLOAD_PROGRESS_INTERVAL_BYTES,
      'YUKI_UPLOAD_PROGRESS_INTERVAL_BYTES',
      1024 * 1024,
      issues,
    ),
    workerPollingIntervalMs: readPositiveInteger(
      environment.YUKI_IMPORT_POLL_INTERVAL_MS,
      'YUKI_IMPORT_POLL_INTERVAL_MS',
      1_000,
      issues,
    ),
    jobLeaseDurationMs: readPositiveInteger(
      environment.YUKI_IMPORT_JOB_LEASE_MS,
      'YUKI_IMPORT_JOB_LEASE_MS',
      30_000,
      issues,
    ),
  };
}

function readPositiveInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  issues: string[],
): number {
  if (value === undefined) return defaultValue;
  if (!/^\d+$/.test(value)) {
    issues.push(`${name} must be a positive safe integer`);
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    issues.push(`${name} must be a positive safe integer`);
    return defaultValue;
  }
  return parsed;
}
