import type { ProcessorSupervisorClientConfiguration } from './client.js';

export function readProcessorSupervisorClientConfiguration(
  environment: NodeJS.ProcessEnv,
): ProcessorSupervisorClientConfiguration {
  return {
    socketPath: required(environment.YUKI_PROCESSOR_SOCKET, 'YUKI_PROCESSOR_SOCKET'),
    authenticationToken: required(environment.YUKI_PROCESSOR_TOKEN, 'YUKI_PROCESSOR_TOKEN'),
    responseWorkspaceRoot: required(
      environment.YUKI_PROCESSOR_RESPONSE_ROOT,
      'YUKI_PROCESSOR_RESPONSE_ROOT',
    ),
    maximumResponseBytes: positiveInteger(
      environment.YUKI_PROCESSOR_MAXIMUM_RESPONSE_BYTES,
      4 * 1024 * 1024 * 1024,
      'YUKI_PROCESSOR_MAXIMUM_RESPONSE_BYTES',
    ),
    maximumOutputFiles: positiveInteger(
      environment.YUKI_PROCESSOR_MAXIMUM_OUTPUT_FILES,
      1_000,
      'YUKI_PROCESSOR_MAXIMUM_OUTPUT_FILES',
    ),
    timeoutMs: positiveInteger(
      environment.YUKI_PROCESSOR_CLIENT_TIMEOUT_MS,
      10 * 60 * 1_000,
      'YUKI_PROCESSOR_CLIENT_TIMEOUT_MS',
    ),
  };
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new TypeError(`${name} is required`);
  return value;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new TypeError(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive integer`);
  return value;
}
