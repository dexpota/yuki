import { stdin, stdout } from 'node:process';

import {
  failureFrom,
  MAX_MESSAGE_BYTES,
  PROCESSOR_PROTOCOL_VERSION,
  type ProcessorFailure,
  type ProcessorResponse,
  ProtocolValidationError,
  parseRequest,
} from './protocol.js';

const PROCESSOR_VERSION = '0.1.0';

export async function processMessage(message: string): Promise<ProcessorResponse> {
  try {
    const request = parseRequest(JSON.parse(message) as unknown);
    return {
      protocolVersion: PROCESSOR_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result: { processorVersion: PROCESSOR_VERSION, capabilities: [] },
    };
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      return failureFrom(error);
    }
    return malformedRequest();
  }
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
