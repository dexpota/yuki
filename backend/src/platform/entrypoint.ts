import { setTimeout as delay } from 'node:timers/promises';

import { ConfigurationError, type RuntimeConfiguration } from './configuration.js';

export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface EntrypointDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly waitForShutdown?: () => Promise<ShutdownSignal>;
  readonly writeStatus?: (message: string) => void;
  readonly writeError?: (message: string) => void;
}

interface Entrypoint<TConfiguration extends RuntimeConfiguration> {
  readonly name: string;
  readonly readConfiguration: (environment: NodeJS.ProcessEnv) => TConfiguration;
  readonly start: (configuration: TConfiguration) => Promise<void>;
  readonly stop: (signal: ShutdownSignal) => Promise<void>;
}

export async function runEntrypoint<TConfiguration extends RuntimeConfiguration>(
  entrypoint: Entrypoint<TConfiguration>,
  dependencies: EntrypointDependencies = {},
): Promise<number> {
  const writeStatus = dependencies.writeStatus ?? console.info;
  const writeError = dependencies.writeError ?? console.error;

  let configuration: TConfiguration;
  try {
    configuration = entrypoint.readConfiguration(dependencies.environment ?? process.env);
  } catch (error) {
    writeError(formatStartupError(entrypoint.name, error));
    return 1;
  }

  try {
    await entrypoint.start(configuration);
    writeStatus(`${entrypoint.name} started`);

    const signal = await (dependencies.waitForShutdown ?? waitForShutdownSignal)();
    writeStatus(`${entrypoint.name} stopping (${signal})`);

    await stopWithinGracePeriod(() => entrypoint.stop(signal), configuration.shutdownGracePeriodMs);
    writeStatus(`${entrypoint.name} stopped`);
    return 0;
  } catch (error) {
    writeError(`${entrypoint.name} failed: ${formatUnknownError(error)}`);
    return 1;
  }
}

export function waitForShutdownSignal(): Promise<ShutdownSignal> {
  return new Promise((resolve) => {
    // Signal listeners do not retain Node's event loop by themselves. This handle
    // keeps an otherwise idle composition root alive until it owns real resources.
    const keepAlive = setInterval(() => {}, 2_147_483_647);
    const onSignal = (signal: ShutdownSignal) => {
      clearInterval(keepAlive);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve(signal);
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

async function stopWithinGracePeriod(
  stop: () => Promise<void>,
  gracePeriodMs: number,
): Promise<void> {
  const cancellation = new AbortController();
  const timeout = delay(gracePeriodMs, undefined, {
    signal: cancellation.signal,
  }).then(() => {
    throw new Error(`shutdown exceeded ${gracePeriodMs}ms grace period`);
  });

  try {
    await Promise.race([stop(), timeout]);
  } finally {
    cancellation.abort();
  }
}

function formatStartupError(name: string, error: unknown): string {
  if (error instanceof ConfigurationError) {
    return `${name} configuration error: ${error.issues.join('; ')}`;
  }

  return `${name} configuration error: ${formatUnknownError(error)}`;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
