import { pathToFileURL } from 'node:url';

import { readWorkerConfiguration } from './platform/configuration.js';
import { type EntrypointDependencies, runEntrypoint } from './platform/entrypoint.js';

export const workerArtifact = 'backend-worker';

export async function runWorker(dependencies: EntrypointDependencies = {}): Promise<number> {
  return runEntrypoint(
    {
      name: workerArtifact,
      readConfiguration: readWorkerConfiguration,
      start: async () => {},
      stop: async () => {},
    },
    dependencies,
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runWorker();
}
