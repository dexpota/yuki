import type { ProcessorResponse } from '../../platform/processor/contract.js';
import {
  type ProcessorRunnerConfiguration,
  type ProcessorRunnerDependencies,
  runProcessor,
} from '../../platform/processor/runner.js';

import {
  type ArchiveProcessingLimits,
  type ArchiveProcessorResult,
  archiveProcessorRequest,
} from './contract.js';
import { parseArchiveProcessorResult } from './result.js';

export interface ArchiveProcessorDependencies {
  readonly runnerDependencies?: ProcessorRunnerDependencies;
  readonly execute?: typeof runProcessor;
}

export class ArchiveProcessingError extends Error {
  override readonly name = 'ArchiveProcessingError';

  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export async function processArchive(
  inputPath: string,
  outputDirectory: string,
  requestId: string,
  limits: ArchiveProcessingLimits,
  configuration: ProcessorRunnerConfiguration,
  dependencies: ArchiveProcessorDependencies = {},
): Promise<ArchiveProcessorResult> {
  const request = archiveProcessorRequest(requestId, limits);
  const execute = dependencies.execute ?? runProcessor;
  const response: ProcessorResponse<ArchiveProcessorResult> = await execute<ArchiveProcessorResult>(
    request,
    configuration,
    dependencies.runnerDependencies,
    [
      { hostPath: inputPath, containerPath: '/input/archive.zip', writable: false },
      { hostPath: outputDirectory, containerPath: '/output/archive', writable: true },
    ],
  );
  if (!response.ok) {
    throw new ArchiveProcessingError(
      response.error.reason ?? response.error.code.toLowerCase(),
      response.error.message,
      response.error.retryable,
    );
  }
  return parseArchiveProcessorResult(response.result);
}
