import type { ExtractArchiveRequest, ExtractArchiveResult } from './archive/index.js';
import {
  type DetectFileRequest,
  type DetectionResult,
  detectionPayloadVersion,
  detectionProcessorOperation,
} from './detection/index.js';
import {
  type GcodeParseLimits,
  gcodeFactsInputPath,
  gcodeFactsOperation,
  gcodeFactsPayloadVersion,
  type ParseGcodeFactsRequest,
  type ParseGcodeFactsResult,
} from './gcode/index.js';
import {
  type GeneratedPreviewDescriptor,
  type GeneratePreviewRequest,
  type PreviewDimensions,
  type PreviewLimits,
  previewInputPath,
  previewOperation,
  previewOutputDirectory,
  previewPayloadVersion,
} from './preview/index.js';

export const PROCESSOR_PROTOCOL_VERSION = 1 as const;
export const MAX_MESSAGE_BYTES = 64 * 1024;

export interface ProbeRequest {
  readonly protocolVersion: typeof PROCESSOR_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: 'probe';
}

export type ArchiveProtocolRequest = ExtractArchiveRequest & {
  readonly protocolVersion: typeof PROCESSOR_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: 'extract-zip';
  readonly payloadVersion: 1;
};

export type PreviewProtocolRequest = GeneratePreviewRequest & {
  readonly protocolVersion: typeof PROCESSOR_PROTOCOL_VERSION;
  readonly requestId: string;
};

export type GcodeFactsProtocolRequest = ParseGcodeFactsRequest & {
  readonly protocolVersion: typeof PROCESSOR_PROTOCOL_VERSION;
  readonly requestId: string;
};

export type ProcessorRequest =
  | ProbeRequest
  | ArchiveProtocolRequest
  | DetectFileRequest
  | PreviewProtocolRequest
  | GcodeFactsProtocolRequest;

export interface ProcessorSuccess<TResult = ProbeResult> {
  readonly protocolVersion: typeof PROCESSOR_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly ok: true;
  readonly result: TResult;
}

export interface ProbeResult {
  readonly processorVersion: string;
  readonly capabilities: readonly string[];
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
    readonly reason?: string;
  };
}

export type PreviewProtocolResult =
  | {
      readonly status: 'ready';
      readonly kind: 'geometry' | 'toolpath';
      readonly files: readonly GeneratedPreviewDescriptor[];
      readonly dimensions?: PreviewDimensions;
      readonly triangleCount?: number;
      readonly layerCount?: number;
      readonly segmentCount?: number;
    }
  | { readonly status: 'unsupported' | 'failed'; readonly reason: string };

export type ProcessorOperationResult =
  | ProbeResult
  | ExtractArchiveResult
  | DetectionResult
  | PreviewProtocolResult
  | ParseGcodeFactsResult;
export type ProcessorResponse = ProcessorSuccess<ProcessorOperationResult> | ProcessorFailure;

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
  if (value.operation === 'probe') return parseProbe(value, value.requestId);
  if (value.operation === 'extract-zip') return parseArchive(value, value.requestId);
  if (value.operation === detectionProcessorOperation)
    return parseDetection(value, value.requestId);
  if (value.operation === previewOperation) return parsePreview(value, value.requestId);
  if (value.operation === gcodeFactsOperation) return parseGcodeFacts(value, value.requestId);
  throw new ProtocolValidationError(
    'UNSUPPORTED_OPERATION',
    'The requested operation is not supported.',
    value.requestId,
  );
}

function parseGcodeFacts(
  value: Record<string, unknown>,
  requestId: string,
): GcodeFactsProtocolRequest {
  exactKeys(value, ['protocolVersion', 'requestId', 'operation', 'payload'], requestId);
  if (!isRecord(value.payload)) malformedOperation(requestId);
  const payload = value.payload as Record<string, unknown>;
  exactKeys(payload, ['version', 'inputPath', 'limits'], requestId);
  if (
    payload.version !== gcodeFactsPayloadVersion ||
    payload.inputPath !== gcodeFactsInputPath ||
    !gcodeLimits(payload.limits)
  )
    malformedOperation(requestId);
  return {
    protocolVersion: PROCESSOR_PROTOCOL_VERSION,
    requestId,
    operation: gcodeFactsOperation,
    payload: {
      version: gcodeFactsPayloadVersion,
      inputPath: gcodeFactsInputPath,
      limits: payload.limits,
    },
  };
}

function parsePreview(value: Record<string, unknown>, requestId: string): PreviewProtocolRequest {
  exactKeys(value, ['protocolVersion', 'requestId', 'operation', 'payload'], requestId);
  if (!isRecord(value.payload)) malformedOperation(requestId);
  const payload = value.payload as Record<string, unknown>;
  exactKeys(payload, ['version', 'inputPath', 'outputDirectory', 'format', 'limits'], requestId);
  if (
    payload.version !== previewPayloadVersion ||
    payload.inputPath !== previewInputPath ||
    payload.outputDirectory !== previewOutputDirectory ||
    !['stl', '3mf', 'obj', 'step', 'gcode'].includes(String(payload.format)) ||
    !previewLimits(payload.limits)
  )
    malformedOperation(requestId);
  return {
    protocolVersion: PROCESSOR_PROTOCOL_VERSION,
    requestId,
    operation: previewOperation,
    payload: {
      version: previewPayloadVersion,
      inputPath: previewInputPath,
      outputDirectory: previewOutputDirectory,
      format: payload.format as PreviewProtocolRequest['payload']['format'],
      limits: payload.limits,
    },
  };
}

function parseProbe(value: Record<string, unknown>, requestId: string): ProbeRequest {
  exactKeys(value, ['protocolVersion', 'requestId', 'operation'], requestId);
  return { protocolVersion: PROCESSOR_PROTOCOL_VERSION, requestId, operation: 'probe' };
}

function parseArchive(value: Record<string, unknown>, requestId: string): ArchiveProtocolRequest {
  exactKeys(
    value,
    [
      'protocolVersion',
      'requestId',
      'operation',
      'payloadVersion',
      'inputPath',
      'outputDirectory',
      'limits',
    ],
    requestId,
  );
  if (
    value.payloadVersion !== 1 ||
    value.inputPath !== '/input/archive.zip' ||
    value.outputDirectory !== '/output/archive' ||
    !archiveLimits(value.limits)
  )
    malformedOperation(requestId);
  return {
    protocolVersion: PROCESSOR_PROTOCOL_VERSION,
    requestId,
    operation: 'extract-zip',
    payloadVersion: 1,
    inputPath: value.inputPath,
    outputDirectory: value.outputDirectory,
    limits: value.limits,
  };
}

function parseDetection(value: Record<string, unknown>, requestId: string): DetectFileRequest {
  exactKeys(
    value,
    [
      'protocolVersion',
      'requestId',
      'operation',
      'payloadVersion',
      'inputPath',
      'filename',
      'limits',
    ],
    requestId,
  );
  if (
    value.payloadVersion !== detectionPayloadVersion ||
    value.inputPath !== '/input/file' ||
    typeof value.filename !== 'string' ||
    value.filename.trim().length < 1 ||
    value.filename.length > 1024 ||
    !detectionLimits(value.limits)
  )
    malformedOperation(requestId);
  return {
    protocolVersion: PROCESSOR_PROTOCOL_VERSION,
    requestId,
    operation: detectionProcessorOperation,
    payloadVersion: detectionPayloadVersion,
    inputPath: value.inputPath,
    filename: value.filename,
    limits: value.limits,
  };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], requestId: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ProtocolValidationError(
      'MALFORMED_REQUEST',
      'Request contains unsupported fields.',
      requestId,
    );
  }
}

function archiveLimits(value: unknown): value is ArchiveProtocolRequest['limits'] {
  return (
    isRecord(value) &&
    exactPositiveIntegerFields(value, [
      'maximumArchiveBytes',
      'maximumMembers',
      'maximumMemberBytes',
      'maximumExpandedBytes',
      'maximumCompressionRatio',
    ])
  );
}

function detectionLimits(value: unknown): value is DetectFileRequest['limits'] {
  return (
    isRecord(value) &&
    exactPositiveIntegerFields(value, [
      'maximumInspectionBytes',
      'maximumStlTriangles',
      'maximumZipEntries',
    ])
  );
}

function previewLimits(value: unknown): value is PreviewLimits {
  return (
    isRecord(value) &&
    exactPositiveIntegerFields(value, [
      'maximumInputBytes',
      'maximumOutputBytes',
      'maximumTriangles',
      'maximumLayers',
      'maximumSegments',
    ])
  );
}

function gcodeLimits(value: unknown): value is GcodeParseLimits {
  return (
    isRecord(value) &&
    exactPositiveIntegerFields(value, [
      'maximumInputBytes',
      'maximumLines',
      'maximumLineBytes',
      'maximumSegments',
      'maximumMetadataEntries',
    ])
  );
}

function exactPositiveIntegerFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every(
      (field) =>
        typeof value[field] === 'number' && Number.isSafeInteger(value[field]) && value[field] > 0,
    )
  );
}

function malformedOperation(requestId: string): never {
  throw new ProtocolValidationError(
    'MALFORMED_REQUEST',
    'Operation request is malformed.',
    requestId,
  );
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
