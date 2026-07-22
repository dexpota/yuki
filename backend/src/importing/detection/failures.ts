export type DetectionFailureKind =
  | 'processor_unavailable'
  | 'processor_timeout'
  | 'processor_resource_limit'
  | 'malformed_file'
  | 'inspection_limit'
  | 'unsupported_protocol'
  | 'processing_failed';

export interface DetectionFailure {
  readonly code: DetectionFailureKind;
  readonly message: string;
  readonly retryable: boolean;
}

/** Maps internal processor failures to stable, sanitized import-facing errors. */
export function classifyDetectionFailure(code: string): DetectionFailure {
  switch (code) {
    case 'PROCESSOR_FAILURE':
      return {
        code: 'processor_unavailable',
        message: 'File inspection is temporarily unavailable.',
        retryable: true,
      };
    case 'TIMEOUT':
    case 'TERMINATED':
      return {
        code: 'processor_timeout',
        message: 'File inspection did not finish within its limit.',
        retryable: true,
      };
    case 'RESOURCE_LIMIT':
      return {
        code: 'processor_resource_limit',
        message: 'File inspection exceeded its assigned resources.',
        retryable: true,
      };
    case 'MALFORMED_FILE':
      return {
        code: 'malformed_file',
        message: 'The file is malformed or truncated.',
        retryable: false,
      };
    case 'INSPECTION_LIMIT':
      return {
        code: 'inspection_limit',
        message: 'The file exceeds a configured inspection limit.',
        retryable: false,
      };
    case 'UNSUPPORTED_PROTOCOL':
    case 'UNSUPPORTED_OPERATION':
      return {
        code: 'unsupported_protocol',
        message: 'The file processor is incompatible with this application version.',
        retryable: false,
      };
    default:
      return {
        code: 'processing_failed',
        message: 'The file could not be inspected.',
        retryable: false,
      };
  }
}
