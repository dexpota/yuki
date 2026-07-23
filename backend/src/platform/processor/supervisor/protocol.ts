import type { Readable } from 'node:stream';

export const SUPERVISOR_PROTOCOL_VERSION = 1 as const;
export const MAX_SUPERVISOR_HEADER_BYTES = 64 * 1024;

export type SupervisorOperation =
  | 'detect-file'
  | 'extract-zip'
  | 'generate-preview'
  | 'parse-gcode-facts';

export interface SupervisorRequestHeader {
  readonly protocolVersion: typeof SUPERVISOR_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly token: string;
  readonly operation: SupervisorOperation;
  readonly inputBytes: number;
  readonly filename?: string;
  readonly format?: 'stl' | '3mf' | 'obj' | 'step' | 'gcode';
  readonly limits: Readonly<Record<string, number>>;
}

export interface SupervisorOutputDescriptor {
  readonly name: string;
  readonly byteSize: number;
  readonly checksum: string;
  readonly mimeType?: string;
}

export type SupervisorResponseHeader =
  | {
      readonly protocolVersion: typeof SUPERVISOR_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly ok: true;
      readonly processorResult: unknown;
      readonly outputCount: number;
    }
  | {
      readonly protocolVersion: typeof SUPERVISOR_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly ok: false;
      readonly error: {
        readonly code: 'AUTHENTICATION_FAILED' | 'BUSY' | 'INVALID_REQUEST' | 'PROCESSOR_FAILURE';
        readonly message: string;
        readonly retryable: boolean;
      };
    };

export interface SupervisorExecutionRequest {
  readonly requestId: string;
  readonly operation: SupervisorOperation;
  readonly inputBytes: number;
  readonly input: Readable | AsyncIterable<Uint8Array>;
  readonly filename?: string;
  readonly format?: 'stl' | '3mf' | 'obj' | 'step' | 'gcode';
  readonly limits: Readonly<Record<string, number>>;
}

export function encodeHeader(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.byteLength > MAX_SUPERVISOR_HEADER_BYTES)
    throw new TypeError('Supervisor header exceeds its byte limit');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(payload.byteLength);
  return Buffer.concat([length, payload]);
}

export function parseRequestHeader(value: unknown): SupervisorRequestHeader {
  if (!isRecord(value)) throw new TypeError('Request header must be an object');
  const allowed = new Set([
    'protocolVersion',
    'requestId',
    'token',
    'operation',
    'inputBytes',
    'filename',
    'format',
    'limits',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new TypeError('Request header contains unsupported fields');
  if (
    value.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION ||
    typeof value.requestId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.requestId) ||
    typeof value.token !== 'string' ||
    !isOperation(value.operation) ||
    !Number.isSafeInteger(value.inputBytes) ||
    Number(value.inputBytes) < 0 ||
    !isLimits(value.limits)
  )
    throw new TypeError('Request header is malformed');
  if (value.operation === 'detect-file' && !validFilename(value.filename))
    throw new TypeError('Detection filename is malformed');
  if (value.operation === 'generate-preview' && !isFormat(value.format))
    throw new TypeError('Preview format is malformed');
  if (value.operation !== 'detect-file' && value.filename !== undefined)
    throw new TypeError('Filename is not allowed for this operation');
  if (value.operation !== 'generate-preview' && value.format !== undefined)
    throw new TypeError('Format is not allowed for this operation');
  return value as unknown as SupervisorRequestHeader;
}

export function parseResponseHeader(value: unknown, requestId: string): SupervisorResponseHeader {
  if (
    !isRecord(value) ||
    value.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION ||
    value.requestId !== requestId ||
    typeof value.ok !== 'boolean'
  )
    throw new TypeError('Supervisor response is malformed');
  if (!value.ok) {
    if (
      !isRecord(value.error) ||
      !['AUTHENTICATION_FAILED', 'BUSY', 'INVALID_REQUEST', 'PROCESSOR_FAILURE'].includes(
        String(value.error.code),
      ) ||
      typeof value.error.message !== 'string' ||
      typeof value.error.retryable !== 'boolean'
    )
      throw new TypeError('Supervisor response is malformed');
    return value as unknown as SupervisorResponseHeader;
  }
  if (!Number.isSafeInteger(value.outputCount) || Number(value.outputCount) < 0)
    throw new TypeError('Supervisor response is malformed');
  return value as unknown as SupervisorResponseHeader;
}

export function parseOutputDescriptor(value: unknown): SupervisorOutputDescriptor {
  if (!isOutput(value)) throw new TypeError('Supervisor output descriptor is malformed');
  return value as unknown as SupervisorOutputDescriptor;
}

function isOutput(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(value.name) &&
    !value.name.split('/').includes('..') &&
    Number.isSafeInteger(value.byteSize) &&
    Number(value.byteSize) >= 0 &&
    typeof value.checksum === 'string' &&
    /^[a-f0-9]{64}$/.test(value.checksum) &&
    (value.mimeType === undefined ||
      (typeof value.mimeType === 'string' &&
        value.mimeType.length >= 1 &&
        value.mimeType.length <= 255))
  );
}

function isLimits(value: unknown): value is Readonly<Record<string, number>> {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 8 &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([key, item]) =>
        /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key) &&
        typeof item === 'number' &&
        Number.isSafeInteger(item) &&
        item > 0,
    )
  );
}

function isOperation(value: unknown): value is SupervisorOperation {
  return ['detect-file', 'extract-zip', 'generate-preview', 'parse-gcode-facts'].includes(
    String(value),
  );
}

function isFormat(value: unknown): value is NonNullable<SupervisorRequestHeader['format']> {
  return ['stl', '3mf', 'obj', 'step', 'gcode'].includes(String(value));
}

function validFilename(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
