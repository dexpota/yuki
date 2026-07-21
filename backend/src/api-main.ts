import { pathToFileURL } from 'node:url';

import { readApiConfiguration } from './platform/configuration.js';
import { type EntrypointDependencies, runEntrypoint } from './platform/entrypoint.js';

export const apiArtifact = 'backend-api';

export async function runApi(dependencies: EntrypointDependencies = {}): Promise<number> {
  return runEntrypoint(
    {
      name: apiArtifact,
      readConfiguration: readApiConfiguration,
      start: async () => {},
      stop: async () => {},
    },
    dependencies,
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runApi();
}
