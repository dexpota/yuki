export const PROCESSOR_PROTOCOL_VERSION = 1 as const;
export const MAX_PROCESSOR_MESSAGE_BYTES = 64 * 1024;

export interface ProcessorRequest {
  readonly protocolVersion: typeof PROCESSOR_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: 'probe';
}

export type ProcessorErrorCode =
  | 'MALFORMED_REQUEST'
  | 'UNSUPPORTED_PROTOCOL'
  | 'UNSUPPORTED_OPERATION'
  | 'PROCESSOR_FAILURE'
  | 'RESOURCE_LIMIT'
  | 'TIMEOUT'
  | 'TERMINATED';

export type ProcessorResponse =
  | {
      readonly protocolVersion: typeof PROCESSOR_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly ok: true;
      readonly result: {
        readonly processorVersion: string;
        readonly capabilities: readonly string[];
      };
    }
  | ProcessorFailure;

export interface ProcessorFailure {
  readonly protocolVersion: typeof PROCESSOR_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly ok: false;
  readonly error: {
    readonly code: ProcessorErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export function probeRequest(requestId: string): ProcessorRequest {
  if (!validRequestId(requestId)) {
    throw new Error('Processor request ID is invalid.');
  }
  return { protocolVersion: PROCESSOR_PROTOCOL_VERSION, requestId, operation: 'probe' };
}

export function parseResponse(value: unknown, expectedRequestId: string): ProcessorResponse {
  if (!isRecord(value) || value.protocolVersion !== PROCESSOR_PROTOCOL_VERSION) {
    throw new Error('Processor returned an unsupported protocol response.');
  }
  if (value.requestId !== expectedRequestId || typeof value.ok !== 'boolean') {
    throw new Error('Processor returned a malformed response.');
  }

  if (value.ok) {
    if (
      !isRecord(value.result) ||
      typeof value.result.processorVersion !== 'string' ||
      !Array.isArray(value.result.capabilities) ||
      !value.result.capabilities.every((item) => typeof item === 'string')
    ) {
      throw new Error('Processor returned a malformed response.');
    }
    return {
      protocolVersion: PROCESSOR_PROTOCOL_VERSION,
      requestId: expectedRequestId,
      ok: true,
      result: {
        processorVersion: value.result.processorVersion,
        capabilities: value.result.capabilities,
      },
    };
  }

  if (
    !isRecord(value.error) ||
    !isErrorCode(value.error.code) ||
    typeof value.error.message !== 'string' ||
    typeof value.error.retryable !== 'boolean'
  ) {
    throw new Error('Processor returned a malformed response.');
  }
  return {
    protocolVersion: PROCESSOR_PROTOCOL_VERSION,
    requestId: expectedRequestId,
    ok: false,
    error: {
      code: value.error.code,
      message: value.error.message,
      retryable: value.error.retryable,
    },
  };
}

export function processorFailure(
  requestId: string,
  code: ProcessorErrorCode,
  message: string,
  retryable: boolean,
): ProcessorFailure {
  return {
    protocolVersion: PROCESSOR_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message, retryable },
  };
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrorCode(value: unknown): value is ProcessorErrorCode {
  return (
    typeof value === 'string' &&
    [
      'MALFORMED_REQUEST',
      'UNSUPPORTED_PROTOCOL',
      'UNSUPPORTED_OPERATION',
      'PROCESSOR_FAILURE',
      'RESOURCE_LIMIT',
      'TIMEOUT',
      'TERMINATED',
    ].includes(value)
  );
}
