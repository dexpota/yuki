export const applicationEnvironments = ['development', 'test', 'production'] as const;

export type ApplicationEnvironment = (typeof applicationEnvironments)[number];

export interface RuntimeConfiguration {
  readonly environment: ApplicationEnvironment;
  readonly shutdownGracePeriodMs: number;
}

export interface ApiConfiguration extends RuntimeConfiguration {
  readonly host: string;
  readonly port: number;
}

export type WorkerConfiguration = RuntimeConfiguration;

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';

  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
  }
}

export function readApiConfiguration(environment: NodeJS.ProcessEnv): ApiConfiguration {
  const issues: string[] = [];
  const runtime = readRuntimeConfiguration(environment, issues);
  const host = readNonEmptyString(environment.YUKI_API_HOST, 'YUKI_API_HOST', issues, '0.0.0.0');
  const port = readInteger(environment.YUKI_API_PORT, 'YUKI_API_PORT', issues, 3000, 1, 65_535);

  assertValid(issues);

  return { ...runtime, host, port };
}

export function readWorkerConfiguration(environment: NodeJS.ProcessEnv): WorkerConfiguration {
  const issues: string[] = [];
  const runtime = readRuntimeConfiguration(environment, issues);

  assertValid(issues);

  return runtime;
}

function readRuntimeConfiguration(
  environment: NodeJS.ProcessEnv,
  issues: string[],
): RuntimeConfiguration {
  const applicationEnvironment = environment.NODE_ENV ?? 'development';
  if (!isApplicationEnvironment(applicationEnvironment)) {
    issues.push(`NODE_ENV must be one of ${applicationEnvironments.join(', ')}`);
  }

  const shutdownGracePeriodMs = readInteger(
    environment.YUKI_SHUTDOWN_GRACE_PERIOD_MS,
    'YUKI_SHUTDOWN_GRACE_PERIOD_MS',
    issues,
    10_000,
    1,
    300_000,
  );

  return {
    environment: isApplicationEnvironment(applicationEnvironment)
      ? applicationEnvironment
      : 'development',
    shutdownGracePeriodMs,
  };
}

function isApplicationEnvironment(value: string): value is ApplicationEnvironment {
  return (applicationEnvironments as readonly string[]).includes(value);
}

function readNonEmptyString(
  value: string | undefined,
  name: string,
  issues: string[],
  defaultValue: string,
): string {
  if (value === undefined) {
    return defaultValue;
  }

  if (value.trim().length === 0) {
    issues.push(`${name} must not be empty`);
    return defaultValue;
  }

  return value;
}

function readInteger(
  value: string | undefined,
  name: string,
  issues: string[],
  defaultValue: number,
  minimum: number,
  maximum: number,
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

function assertValid(issues: string[]): asserts issues is [] {
  if (issues.length > 0) {
    throw new ConfigurationError(issues);
  }
}
