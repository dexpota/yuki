export type ImportAssetFormat =
  | 'stl'
  | '3mf'
  | 'obj'
  | 'step'
  | 'gcode'
  | 'image'
  | 'document'
  | 'archive'
  | 'other';

export interface DetectionFacts {
  readonly format: ImportAssetFormat;
  readonly mimeType: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DuplicateCandidate {
  readonly ownerId: string;
  readonly assetId: string;
  readonly modelId: string;
  readonly originalFilename: string;
  readonly checksum: string;
}

export interface FileImportWarning {
  readonly code:
    | 'exact_duplicate'
    | 'unsupported_content'
    | 'filename_mismatch'
    | 'metadata_truncated';
  readonly message: string;
  readonly relatedAssetIds?: readonly string[];
}

export interface FileImportSuccess {
  readonly status: 'accepted';
  readonly fileId: string;
  readonly originalFilename: string;
  readonly checksum: string;
  readonly detection: DetectionFacts;
  readonly warnings: readonly FileImportWarning[];
}

export interface FileImportFailure {
  readonly status: 'failed';
  readonly fileId: string;
  readonly originalFilename: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type FileImportResult = FileImportSuccess | FileImportFailure;

export interface ImportDetectionReport {
  readonly files: readonly FileImportResult[];
  readonly acceptedCount: number;
  readonly failedCount: number;
  /** Publication must be atomic; false means no catalogue rows may be exposed. */
  readonly publishable: boolean;
  readonly retryable: boolean;
}

export function exactDuplicateWarning(
  ownerId: string,
  checksum: string,
  candidates: readonly DuplicateCandidate[],
): FileImportWarning | undefined {
  if (!ownerId.trim()) throw new TypeError('Owner ID is required.');
  validateChecksum(checksum);
  const matches = candidates.filter(
    (candidate) =>
      candidate.ownerId === ownerId && candidate.checksum.toLowerCase() === checksum.toLowerCase(),
  );
  if (matches.length === 0) return undefined;
  return {
    code: 'exact_duplicate',
    message:
      'This file has the same content as an existing asset. You may keep it as a separate logical asset.',
    relatedAssetIds: [...new Set(matches.map((match) => match.assetId))],
  };
}

export function acceptedFile(input: {
  readonly fileId: string;
  readonly originalFilename: string;
  readonly checksum: string;
  readonly detection: DetectionFacts;
  readonly warnings?: readonly FileImportWarning[];
}): FileImportSuccess {
  validateIdentity(input.fileId, input.originalFilename);
  validateChecksum(input.checksum);
  const unsupported: FileImportWarning[] =
    input.detection.format === 'other'
      ? [
          {
            code: 'unsupported_content',
            message:
              'The file is retained as an original asset but has no supported preview or print workflow.',
          },
        ]
      : [];
  return { status: 'accepted', ...input, warnings: [...(input.warnings ?? []), ...unsupported] };
}

export function failedFile(input: {
  readonly fileId: string;
  readonly originalFilename: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}): FileImportFailure {
  validateIdentity(input.fileId, input.originalFilename);
  return {
    status: 'failed',
    fileId: input.fileId,
    originalFilename: input.originalFilename,
    error: {
      code: sanitizeCode(input.code),
      message: sanitizeMessage(input.message),
      retryable: input.retryable,
    },
  };
}

export function detectionReport(files: readonly FileImportResult[]): ImportDetectionReport {
  const acceptedCount = files.filter((file) => file.status === 'accepted').length;
  const failures = files.filter((file): file is FileImportFailure => file.status === 'failed');
  return {
    files,
    acceptedCount,
    failedCount: failures.length,
    publishable: files.length > 0 && failures.length === 0,
    retryable: failures.length > 0 && failures.every((file) => file.error.retryable),
  };
}

function sanitizeCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/g, '_')
    .slice(0, 80);
  return normalized || 'file_processing_failed';
}
function sanitizeMessage(value: string): string {
  const printable = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('');
  const clean = printable.replaceAll(/\s+/g, ' ').trim().slice(0, 300);
  return clean || 'The file could not be processed.';
}
function validateChecksum(value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new TypeError('Checksum must be SHA-256.');
}
function validateIdentity(fileId: string, filename: string): void {
  if (!fileId.trim() || !filename.trim() || filename.length > 1024)
    throw new TypeError('File identity is invalid.');
}
