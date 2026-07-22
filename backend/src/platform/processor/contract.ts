export const PROCESSOR_PROTOCOL_VERSION = 1 as const;
export const MAX_PROCESSOR_MESSAGE_BYTES = 64 * 1024;

export interface ProcessorRequest<TResult = unknown> {
  readonly protocolVersion: typeof PROCESSOR_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: string;
  /** Carries the operation result type without adding anything to the wire format. */
  readonly __resultType?: TResult;
}

export type ProcessorErrorCode =
  | 'MALFORMED_REQUEST'
  | 'UNSUPPORTED_PROTOCOL'
  | 'UNSUPPORTED_OPERATION'
  | 'PROCESSOR_FAILURE'
  | 'RESOURCE_LIMIT'
  | 'TIMEOUT'
  | 'TERMINATED';

export interface ProbeResult {
  readonly processorVersion: string;
  readonly capabilities: readonly string[];
}

export type ProcessorResponse<TResult = ProbeResult> =
  | {
      readonly protocolVersion: typeof PROCESSOR_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly ok: true;
      readonly result: TResult;
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
    readonly reason?: string;
  };
}

export function probeRequest(requestId: string): ProcessorRequest<ProbeResult> {
  if (!validRequestId(requestId)) {
    throw new Error('Processor request ID is invalid.');
  }
  return { protocolVersion: PROCESSOR_PROTOCOL_VERSION, requestId, operation: 'probe' };
}

export function parseResponse<TResult = ProbeResult>(
  value: unknown,
  expectedRequestId: string,
  operation = 'probe',
): ProcessorResponse<TResult> {
  if (!isRecord(value) || value.protocolVersion !== PROCESSOR_PROTOCOL_VERSION) {
    throw new Error('Processor returned an unsupported protocol response.');
  }
  if (value.requestId !== expectedRequestId || typeof value.ok !== 'boolean') {
    throw new Error('Processor returned a malformed response.');
  }

  if (value.ok) {
    if (!('result' in value)) {
      throw new Error('Processor returned a malformed response.');
    }
    if (
      operation === 'probe' &&
      (!isRecord(value.result) ||
        typeof value.result.processorVersion !== 'string' ||
        !Array.isArray(value.result.capabilities) ||
        !value.result.capabilities.every((item) => typeof item === 'string'))
    )
      throw new Error('Processor returned a malformed response.');
    return {
      protocolVersion: PROCESSOR_PROTOCOL_VERSION,
      requestId: expectedRequestId,
      ok: true,
      result: value.result as TResult,
    };
  }

  if (
    !isRecord(value.error) ||
    !isErrorCode(value.error.code) ||
    typeof value.error.message !== 'string' ||
    typeof value.error.retryable !== 'boolean' ||
    (value.error.reason !== undefined &&
      (typeof value.error.reason !== 'string' || !/^[a-z0-9_]{1,80}$/.test(value.error.reason)))
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
      ...(value.error.reason === undefined ? {} : { reason: value.error.reason }),
    },
  };
}

export function processorFailure(
  requestId: string,
  code: ProcessorErrorCode,
  message: string,
  retryable: boolean,
  reason?: string,
): ProcessorFailure {
  return {
    protocolVersion: PROCESSOR_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message, retryable, ...(reason === undefined ? {} : { reason }) },
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
