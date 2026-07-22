import type { ProcessorResponse } from '../../platform/processor/contract.js';
import {
  type ProcessorRunnerConfiguration,
  type ProcessorRunnerDependencies,
  runProcessor,
} from '../../platform/processor/runner.js';

import {
  type DetectionProcessingLimits,
  type DetectionProcessorResult,
  detectionProcessorRequest,
  parseDetectionProcessorResult,
} from './contract.js';
import { classifyDetectionFailure, type DetectionFailure } from './failures.js';

export interface DetectionProcessorDependencies {
  readonly runnerDependencies?: ProcessorRunnerDependencies;
  readonly execute?: typeof runProcessor;
}

export class DetectionProcessingError extends Error {
  override readonly name = 'DetectionProcessingError';

  constructor(public readonly failure: DetectionFailure) {
    super(failure.message);
  }
}

export async function processFileDetection(
  inputPath: string,
  filename: string,
  requestId: string,
  limits: DetectionProcessingLimits,
  configuration: ProcessorRunnerConfiguration,
  dependencies: DetectionProcessorDependencies = {},
): Promise<DetectionProcessorResult> {
  const request = detectionProcessorRequest(requestId, filename, limits);
  const execute = dependencies.execute ?? runProcessor;
  const response: ProcessorResponse<DetectionProcessorResult> =
    await execute<DetectionProcessorResult>(
      request,
      configuration,
      dependencies.runnerDependencies,
      [{ hostPath: inputPath, containerPath: '/input/file', writable: false }],
    );
  if (!response.ok) {
    const classificationCode =
      response.error.reason === 'detection_limit' ? 'INSPECTION_LIMIT' : response.error.code;
    throw new DetectionProcessingError(classifyDetectionFailure(classificationCode));
  }
  return parseDetectionProcessorResult(response.result);
}
