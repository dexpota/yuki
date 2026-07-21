export interface DatabaseConfiguration {
  readonly connectionString: string;
  readonly maximumPoolSize: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly applicationName: string;
}

export class DatabaseConfigurationError extends Error {
  override readonly name = 'DatabaseConfigurationError';

  constructor(readonly issues: readonly string[]) {
    super(`Invalid database configuration: ${issues.join('; ')}`);
  }
}

export function readDatabaseConfiguration(environment: NodeJS.ProcessEnv): DatabaseConfiguration {
  const issues: string[] = [];
  const connectionString = readConnectionString(environment.YUKI_DATABASE_URL, issues);

  const configuration = {
    connectionString,
    maximumPoolSize: readInteger(
      environment.YUKI_DATABASE_POOL_MAX,
      'YUKI_DATABASE_POOL_MAX',
      10,
      1,
      100,
      issues,
    ),
    connectionTimeoutMs: readInteger(
      environment.YUKI_DATABASE_CONNECTION_TIMEOUT_MS,
      'YUKI_DATABASE_CONNECTION_TIMEOUT_MS',
      5_000,
      1,
      300_000,
      issues,
    ),
    idleTimeoutMs: readInteger(
      environment.YUKI_DATABASE_IDLE_TIMEOUT_MS,
      'YUKI_DATABASE_IDLE_TIMEOUT_MS',
      30_000,
      1,
      3_600_000,
      issues,
    ),
    statementTimeoutMs: readInteger(
      environment.YUKI_DATABASE_STATEMENT_TIMEOUT_MS,
      'YUKI_DATABASE_STATEMENT_TIMEOUT_MS',
      30_000,
      1,
      3_600_000,
      issues,
    ),
    applicationName: readApplicationName(environment.YUKI_DATABASE_APPLICATION_NAME, issues),
  } satisfies DatabaseConfiguration;

  if (issues.length > 0) {
    throw new DatabaseConfigurationError(issues);
  }

  return configuration;
}

function readConnectionString(value: string | undefined, issues: string[]): string {
  if (value === undefined || value.trim().length === 0) {
    issues.push('YUKI_DATABASE_URL is required');
    return 'postgresql://invalid';
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      issues.push('YUKI_DATABASE_URL must use the postgres or postgresql protocol');
    }
  } catch {
    issues.push('YUKI_DATABASE_URL must be a valid PostgreSQL URL');
  }

  return value;
}

function readApplicationName(value: string | undefined, issues: string[]): string {
  const applicationName = value ?? 'yuki';
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(applicationName)) {
    issues.push('YUKI_DATABASE_APPLICATION_NAME must contain 1-63 letters, digits, _ or -');
    return 'yuki';
  }
  return applicationName;
}

function readInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
  issues: string[],
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!/^\d+$/.test(value)) {
    issues.push(`${name} must be an integer between ${minimum} and ${maximum}`);
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push(`${name} must be an integer between ${minimum} and ${maximum}`);
    return defaultValue;
  }
  return parsed;
}
