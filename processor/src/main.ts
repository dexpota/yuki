import { readFile, stat } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';

import { ArchiveRejectedError, extractArchive } from './archive/index.js';
import { DetectionLimitError, detectAsset, FileRandomAccessInput } from './detection/index.js';
import { GcodeParseError, gcodeFactsOperation, parseGcodeFacts } from './gcode/index.js';
import { generatePreviewFiles, PreviewLimitError, previewOperation } from './preview/index.js';
import {
  failureFrom,
  MAX_MESSAGE_BYTES,
  PROCESSOR_PROTOCOL_VERSION,
  type ProcessorFailure,
  type ProcessorOperationResult,
  type ProcessorRequest,
  type ProcessorResponse,
  ProtocolValidationError,
  parseRequest,
} from './protocol.js';

const PROCESSOR_VERSION = '0.1.0';

export async function processMessage(message: string): Promise<ProcessorResponse> {
  let value: unknown;
  try {
    value = JSON.parse(message) as unknown;
  } catch {
    return malformedRequest();
  }

  let request: ProcessorRequest;
  try {
    request = parseRequest(value);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      return failureFrom(error);
    }
    return malformedRequest();
  }

  try {
    if (request.operation === 'probe') {
      return success(request.requestId, {
        processorVersion: PROCESSOR_VERSION,
        capabilities: ['detect-file', 'extract-zip', previewOperation, gcodeFactsOperation],
      });
    }
    if (request.operation === 'extract-zip') {
      return success(request.requestId, await extractArchive(request));
    }
    if (request.operation === previewOperation) {
      return success(
        request.requestId,
        await generatePreviewFiles(
          request.payload.inputPath,
          request.payload.outputDirectory,
          request.payload.format,
          request.payload.limits,
        ),
      );
    }
    if (request.operation === gcodeFactsOperation) {
      const metadata = await stat(request.payload.inputPath);
      if (!metadata.isFile() || metadata.size > request.payload.limits.maximumInputBytes)
        throw new GcodeParseError('input-too-large');
      return success(request.requestId, {
        status: 'ready',
        facts: parseGcodeFacts(await readFile(request.payload.inputPath), request.payload.limits),
      });
    }

    const input = await FileRandomAccessInput.open(request.inputPath);
    try {
      return success(request.requestId, await detectAsset(input, request.filename, request.limits));
    } finally {
      await input.close();
    }
  } catch (error) {
    if (error instanceof ArchiveRejectedError) {
      return processingFailure(request.requestId, error.message, error.code);
    }
    if (error instanceof DetectionLimitError) {
      return processingFailure(
        request.requestId,
        'The file could not be inspected within the configured limits.',
        'detection_limit',
      );
    }
    if (error instanceof PreviewLimitError) {
      return processingFailure(
        request.requestId,
        'The preview could not be generated within the configured limits.',
        'preview_limit',
      );
    }
    if (error instanceof GcodeParseError) {
      return processingFailure(
        request.requestId,
        error.message,
        `gcode_${error.code.replaceAll('-', '_')}`,
      );
    }
    return processingFailure(
      request.requestId,
      'The file processor could not complete the operation.',
      'unexpected_failure',
      true,
    );
  }
}

function success<TResult extends ProcessorOperationResult>(
  requestId: string,
  result: TResult,
): ProcessorResponse {
  return { protocolVersion: PROCESSOR_PROTOCOL_VERSION, requestId, ok: true, result };
}

function processingFailure(
  requestId: string,
  message: string,
  reason: string,
  retryable = false,
): ProcessorFailure {
  return {
    protocolVersion: PROCESSOR_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code: 'PROCESSOR_FAILURE', message, retryable, reason },
  };
}

async function main(): Promise<void> {
  let bytes = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_MESSAGE_BYTES) {
      stdout.write(`${JSON.stringify(malformedRequest())}\n`);
      return;
    }
    chunks.push(buffer);
  }

  const response = await processMessage(Buffer.concat(chunks).toString('utf8').trim());
  stdout.write(`${JSON.stringify(response)}\n`);
}

function malformedRequest(): ProcessorFailure {
  return {
    protocolVersion: PROCESSOR_PROTOCOL_VERSION,
    requestId: 'unknown',
    ok: false,
    error: {
      code: 'MALFORMED_REQUEST',
      message: 'Request is not valid processor protocol JSON.',
      retryable: false,
    },
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch(() => {
    stdout.write(`${JSON.stringify(malformedRequest())}\n`);
    process.exitCode = 1;
  });
}
