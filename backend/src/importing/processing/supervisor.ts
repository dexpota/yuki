import { randomUUID } from 'node:crypto';

import {
  type ProcessorSupervisorClient,
  ProcessorSupervisorError,
  type SupervisorOutput,
} from '../../platform/processor/supervisor/index.js';
import {
  type DetectionProcessingLimits,
  type DetectionProcessorResult,
  parseDetectionProcessorResult,
} from '../detection/index.js';
import type {
  ImportContentProcessor,
  ImportProcessingInput,
  PreparedImportBatch,
  PreparedImportFile,
  RejectedImportFile,
} from './contracts.js';

export interface SupervisorImportProcessorOptions {
  readonly detection: DetectionProcessingLimits;
  readonly archive: {
    readonly maximumArchiveBytes: number;
    readonly maximumMembers: number;
    readonly maximumMemberBytes: number;
    readonly maximumExpandedBytes: number;
    readonly maximumCompressionRatio: number;
  };
}

export const defaultSupervisorImportProcessorOptions: SupervisorImportProcessorOptions = {
  detection: {
    maximumInspectionBytes: 8 * 1024 * 1024,
    maximumStlTriangles: 2_000_000,
    maximumZipEntries: 10_000,
  },
  archive: {
    maximumArchiveBytes: 2 * 1024 * 1024 * 1024,
    maximumMembers: 1_000,
    maximumMemberBytes: 2 * 1024 * 1024 * 1024,
    maximumExpandedBytes: 10 * 1024 * 1024 * 1024,
    maximumCompressionRatio: 200,
  },
};

export class SupervisorImportContentProcessor implements ImportContentProcessor {
  public constructor(
    private readonly client: ProcessorSupervisorClient,
    private readonly options: SupervisorImportProcessorOptions = defaultSupervisorImportProcessorOptions,
  ) {}

  public async inspect(input: ImportProcessingInput): Promise<PreparedImportBatch> {
    const originalDetection = await this.detect(
      `${input.sessionId}:original`,
      input.originalFilename,
      input.size,
      await input.openOriginal(),
    );
    if (originalDetection.format !== 'archive') {
      return { kind: 'file', originalDetection, files: [] };
    }

    const extraction = await this.client.execute({
      requestId: requestId(input.sessionId, 'extract'),
      operation: 'extract-zip',
      inputBytes: input.size,
      input: await input.openOriginal(),
      limits: this.options.archive,
    });
    try {
      const files: Array<PreparedImportFile | RejectedImportFile> = [];
      for (const output of extraction.outputs)
        files.push(await this.member(input.sessionId, output));
      return { kind: 'archive', originalDetection, files, cleanup: extraction.cleanup };
    } catch (error) {
      await extraction.cleanup();
      throw error;
    }
  }

  private async member(
    sessionId: string,
    output: SupervisorOutput,
  ): Promise<PreparedImportFile | RejectedImportFile> {
    try {
      const detection = await this.detect(
        `${sessionId}:${output.name}`,
        output.name,
        output.byteSize,
        output.open(),
      );
      return {
        fileKey: output.name,
        originalFilename: output.name,
        size: output.byteSize,
        checksum: output.checksum,
        detection,
        open: async () => output.open(),
      };
    } catch (error) {
      return {
        fileKey: output.name,
        originalFilename: output.name,
        size: output.byteSize,
        checksum: output.checksum,
        error: memberFailure(error),
      };
    }
  }

  private async detect(
    id: string,
    filename: string,
    size: number,
    input: AsyncIterable<Uint8Array>,
  ): Promise<DetectionProcessorResult> {
    const execution = await this.client.execute({
      requestId: requestId(id, randomUUID()),
      operation: 'detect-file',
      inputBytes: size,
      input,
      filename,
      limits: { ...this.options.detection },
    });
    try {
      return parseDetectionProcessorResult(execution.processorResult);
    } finally {
      await execution.cleanup();
    }
  }
}

function memberFailure(error: unknown): RejectedImportFile['error'] {
  if (error instanceof ProcessorSupervisorError) {
    return {
      code: error.code,
      message: 'The archive member could not be inspected',
      retryable: error.retryable,
    };
  }
  return {
    code: 'malformed_processor_response',
    message: 'The archive member could not be inspected',
    retryable: false,
  };
}

function requestId(...parts: readonly string[]): string {
  const seed = parts.join(':').replaceAll(/[^A-Za-z0-9._:-]/g, '_');
  return seed.slice(0, 96) || randomUUID();
}
