import { pathToFileURL } from 'node:url';

import { readWorkerConfiguration } from './platform/configuration.js';
import { type EntrypointDependencies, runEntrypoint } from './platform/entrypoint.js';
import { createHttpApplication } from './platform/http/application.js';
import {
  createJsonLogger,
  HealthRegistry,
  installHttpObservability,
  type Logger,
} from './platform/observability/index.js';

export const workerArtifact = 'backend-worker';

export async function runWorker(dependencies: EntrypointDependencies = {}): Promise<number> {
  const logger = createEntrypointLogger(workerArtifact, dependencies);
  let diagnostics: Awaited<ReturnType<typeof createWorkerDiagnosticsApplication>> | undefined;
  return runEntrypoint(
    {
      name: workerArtifact,
      readConfiguration: readWorkerConfiguration,
      start: async (configuration) => {
        const health = new HealthRegistry();
        diagnostics = await createWorkerDiagnosticsApplication(logger, health);
        try {
          if (configuration.environment !== 'test') {
            await diagnostics.listen({
              host: '127.0.0.1',
              port: readDiagnosticsPort(dependencies.environment ?? process.env),
            });
          }
          health.setAcceptingWork(true);
        } catch (error) {
          await diagnostics.close();
          diagnostics = undefined;
          throw error;
        }
      },
      stop: async () => {
        await diagnostics?.close();
        diagnostics = undefined;
      },
    },
    withStructuredStatus(dependencies, logger),
  );
}

export async function createWorkerDiagnosticsApplication(logger: Logger, health: HealthRegistry) {
  const application = await createHttpApplication();
  installHttpObservability(application, { service: workerArtifact, logger, health });
  return application;
}

function readDiagnosticsPort(environment: NodeJS.ProcessEnv): number {
  const raw = environment.YUKI_WORKER_DIAGNOSTICS_PORT ?? '3001';
  if (!/^\d+$/.test(raw)) throw new Error('YUKI_WORKER_DIAGNOSTICS_PORT must be an integer');
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('YUKI_WORKER_DIAGNOSTICS_PORT must be between 1 and 65535');
  }
  return port;
}

function createEntrypointLogger(name: string, dependencies: EntrypointDependencies): Logger {
  return createJsonLogger({
    service: name,
    ...(dependencies.writeStatus === undefined ? {} : { write: dependencies.writeStatus }),
  });
}

function withStructuredStatus(
  dependencies: EntrypointDependencies,
  logger: Logger,
): EntrypointDependencies {
  return {
    ...dependencies,
    writeStatus:
      dependencies.writeStatus ?? ((message) => logger.info('runtime_status', { message })),
    writeError:
      dependencies.writeError ?? ((message) => logger.error('runtime_error', { message })),
  };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runWorker();
}
