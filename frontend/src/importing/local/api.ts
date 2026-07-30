import { ApiError, apiRequest, sessionExpiredEvent } from '../../shared/api/http.js';

export type ImportSessionState = 'receiving' | 'queued' | 'processing' | 'succeeded' | 'failed';

export interface ImportWarning {
  readonly code: string;
  readonly message: string;
  readonly relatedAssetIds?: readonly string[];
}

export interface ImportFileReport {
  readonly id: string;
  readonly fileKey: string;
  readonly originalFilename: string;
  readonly isOriginal: boolean;
  readonly status: 'accepted' | 'failed';
  readonly role: string | null;
  readonly format: string | null;
  readonly detectedMimeType: string | null;
  readonly byteSize: number;
  readonly checksum: string;
  readonly detection: unknown | null;
  readonly warnings: unknown;
  readonly duplicateAssetIds: readonly string[];
  readonly duplicateDecision: 'not_required' | 'required' | 'keep';
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

export interface LocalImportSession {
  readonly id: string;
  readonly state: ImportSessionState;
  readonly originalFilename: string;
  readonly modelName: string;
  readonly uploadedBytes: number;
  readonly declaredLength?: number;
  readonly checksum: string | null;
  readonly progress: number;
  readonly modelId: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly files?: readonly ImportFileReport[];
}

export interface UploadLocalImportInput {
  readonly file: File;
  readonly modelName: string;
  readonly targetModelId?: string;
  readonly versionLabel?: string;
  readonly changeNote?: string;
  readonly csrfToken: string;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

export function uploadLocalImport(input: UploadLocalImportInput): Promise<LocalImportSession> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(
      'POST',
      input.targetModelId
        ? `/api/v1/catalogue/models/${encodeURIComponent(input.targetModelId)}/versions/import`
        : '/api/v1/imports/local',
    );
    request.withCredentials = true;
    request.responseType = 'json';
    request.setRequestHeader('content-type', 'application/octet-stream');
    if (input.file.type) request.setRequestHeader('x-yuki-claimed-mime-type', input.file.type);
    request.setRequestHeader('x-csrf-token', input.csrfToken);
    request.setRequestHeader('x-yuki-value-encoding', 'percent');
    request.setRequestHeader('x-yuki-filename', encodeURIComponent(input.file.name));
    if (input.targetModelId) {
      request.setRequestHeader(
        'x-yuki-version-label',
        encodeURIComponent(input.versionLabel ?? ''),
      );
      if (input.changeNote?.trim())
        request.setRequestHeader('x-yuki-change-note', encodeURIComponent(input.changeNote.trim()));
    } else {
      request.setRequestHeader('x-yuki-model-name', encodeURIComponent(input.modelName.trim()));
    }
    request.setRequestHeader('idempotency-key', input.idempotencyKey);
    request.upload.addEventListener('progress', (event) => {
      input.onProgress?.(event.loaded, event.lengthComputable ? event.total : input.file.size);
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(readSession(request.response));
        return;
      }
      const error = readApiError(request.response, request.status);
      if (request.status === 401) window.dispatchEvent(new Event(sessionExpiredEvent));
      reject(error);
    });
    request.addEventListener('error', () => {
      reject(new ApiError(0, 'upload_unavailable', 'The upload connection was interrupted.'));
    });
    request.addEventListener('abort', () => {
      reject(new DOMException('The upload was cancelled.', 'AbortError'));
    });
    const abort = () => request.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    request.addEventListener('loadend', () => input.signal?.removeEventListener('abort', abort));
    request.send(input.file);
  });
}

export function getLocalImport(sessionId: string): Promise<LocalImportSession> {
  return apiRequest(`/api/v1/imports/${encodeURIComponent(sessionId)}`).then(readSession);
}

export function keepExactDuplicates(
  sessionId: string,
  fileIds: readonly string[],
  csrfToken: string,
): Promise<{ readonly sessionId: string; readonly decision: 'keep'; readonly fileIds: string[] }> {
  return apiRequest(`/api/v1/imports/${encodeURIComponent(sessionId)}/duplicate-decisions`, {
    method: 'POST',
    csrfToken,
    body: JSON.stringify({ decision: 'keep', fileIds }),
  });
}

export function importWarnings(value: unknown): readonly ImportWarning[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((warning) => {
    if (
      typeof warning !== 'object' ||
      warning === null ||
      !('code' in warning) ||
      typeof warning.code !== 'string' ||
      !('message' in warning) ||
      typeof warning.message !== 'string'
    )
      return [];
    const relatedAssetIds =
      'relatedAssetIds' in warning &&
      Array.isArray(warning.relatedAssetIds) &&
      warning.relatedAssetIds.every((id: unknown) => typeof id === 'string')
        ? warning.relatedAssetIds
        : undefined;
    return [
      {
        code: warning.code,
        message: warning.message,
        ...(relatedAssetIds ? { relatedAssetIds } : {}),
      },
    ];
  });
}

function readSession(value: unknown): LocalImportSession {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('state' in value) ||
    !['receiving', 'queued', 'processing', 'succeeded', 'failed'].includes(String(value.state))
  ) {
    throw new ApiError(0, 'import_response_invalid', 'The server returned an invalid import.');
  }
  return value as LocalImportSession;
}

function readApiError(value: unknown, status: number): ApiError {
  const body =
    typeof value === 'object' && value !== null && 'error' in value
      ? (value.error as Record<string, unknown> | null)
      : null;
  return new ApiError(
    status,
    typeof body?.code === 'string' ? body.code : 'upload_failed',
    typeof body?.message === 'string' ? body.message : 'The file could not be uploaded.',
    typeof body?.requestId === 'string' ? body.requestId : undefined,
  );
}
