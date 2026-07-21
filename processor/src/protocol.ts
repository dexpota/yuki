export const PROCESSOR_PROTOCOL_VERSION = 1 as const;
export const MAX_MESSAGE_BYTES = 64 * 1024;

export interface ProcessorRequest {
  readonly protocolVersion: typeof PROCESSOR_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: 'probe';
}

export interface ProcessorSuccess {
  readonly protocolVersion: typeof PROCESSOR_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly ok: true;
  readonly result: {
    readonly processorVersion: string;
    readonly capabilities: readonly string[];
  };
}

export type ProcessorErrorCode =
  | 'MALFORMED_REQUEST'
  | 'UNSUPPORTED_PROTOCOL'
  | 'UNSUPPORTED_OPERATION'
  | 'PROCESSOR_FAILURE'
  | 'RESOURCE_LIMIT'
  | 'TIMEOUT'
  | 'TERMINATED';

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

export type ProcessorResponse = ProcessorSuccess | ProcessorFailure;

export class ProtocolValidationError extends Error {
  public constructor(
    public readonly code: 'MALFORMED_REQUEST' | 'UNSUPPORTED_PROTOCOL' | 'UNSUPPORTED_OPERATION',
    message: string,
    public readonly requestId = 'unknown',
  ) {
    super(message);
  }
}

export function parseRequest(value: unknown): ProcessorRequest {
  if (!isRecord(value)) {
    throw new ProtocolValidationError('MALFORMED_REQUEST', 'Request must be a JSON object.');
  }

  const requestId = validRequestId(value.requestId) ? value.requestId : 'unknown';
  if (value.protocolVersion !== PROCESSOR_PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      'UNSUPPORTED_PROTOCOL',
      `Protocol version ${PROCESSOR_PROTOCOL_VERSION} is required.`,
      requestId,
    );
  }
  if (!validRequestId(value.requestId)) {
    throw new ProtocolValidationError(
      'MALFORMED_REQUEST',
      'requestId must contain 1 to 128 safe characters.',
    );
  }
  if (value.operation !== 'probe') {
    throw new ProtocolValidationError(
      'UNSUPPORTED_OPERATION',
      'The requested operation is not supported.',
      value.requestId,
    );
  }
  if (
    Object.keys(value).some((key) => !['protocolVersion', 'requestId', 'operation'].includes(key))
  ) {
    throw new ProtocolValidationError(
      'MALFORMED_REQUEST',
      'Request contains unsupported fields.',
      value.requestId,
    );
  }

  return {
    protocolVersion: PROCESSOR_PROTOCOL_VERSION,
    requestId: value.requestId,
    operation: value.operation,
  };
}

export function failureFrom(error: ProtocolValidationError): ProcessorFailure {
  return {
    protocolVersion: PROCESSOR_PROTOCOL_VERSION,
    requestId: error.requestId,
    ok: false,
    error: { code: error.code, message: error.message, retryable: false },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
