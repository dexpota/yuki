import { apiRequest } from '../../shared/api/http.js';

export type PrintOutcome = 'successful' | 'failed' | 'cancelled' | 'unknown';
export type PrintAttemptSource = 'remote' | 'manual' | 'external';

export interface PrintPhoto {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly checksum: string;
  readonly createdAt: string;
  readonly downloadUrl: string;
}

export interface PrintAttempt {
  readonly id: string;
  readonly source: PrintAttemptSource;
  readonly queueEntryId: string | null;
  readonly printerId: string | null;
  readonly modelId: string | null;
  readonly modelVersionId: string | null;
  readonly assetId: string | null;
  readonly state: string;
  readonly outcome: PrintOutcome | null;
  readonly notes: string;
  readonly statistics: unknown;
  readonly printerSnapshot: unknown;
  readonly modelSnapshot: unknown;
  readonly assetSnapshot: unknown;
  readonly compatibilitySnapshot: unknown;
  readonly overrideJustification: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly photos: readonly PrintPhoto[];
}

export interface PrinterSummary {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly connectionStatus: 'online' | 'offline' | 'unknown';
}

export interface ManualAttemptInput {
  readonly modelId: string;
  readonly modelVersionId: string;
  readonly assetId: string;
  readonly printerId: string;
  readonly source: 'manual' | 'external';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: PrintOutcome;
  readonly notes?: string;
}

export function listPrintAttempts(filters: {
  readonly modelId?: string;
  readonly printerId?: string;
}): Promise<{ readonly attempts: readonly PrintAttempt[] }> {
  const query = new URLSearchParams({ limit: '50' });
  if (filters.modelId) query.set('modelId', filters.modelId);
  if (filters.printerId) query.set('printerId', filters.printerId);
  return apiRequest(`/api/v1/printing/print-attempts?${query}`);
}

export function listPrinters(): Promise<readonly PrinterSummary[]> {
  return apiRequest('/api/v1/printing/printers');
}

export function createManualAttempt(
  input: ManualAttemptInput,
  csrfToken: string,
): Promise<PrintAttempt> {
  return apiRequest('/api/v1/printing/print-attempts', {
    method: 'POST',
    body: JSON.stringify(input),
    csrfToken,
    headers: { 'idempotency-key': requestKey() },
  });
}

export function correctPrintOutcome(
  attemptId: string,
  outcome: PrintOutcome,
  reason: string,
  csrfToken: string,
): Promise<PrintAttempt> {
  return apiRequest(`${attemptPath(attemptId)}/outcome-corrections`, {
    method: 'POST',
    body: JSON.stringify({ outcome, reason }),
    csrfToken,
    headers: { 'idempotency-key': requestKey() },
  });
}

export function updatePrintNotes(
  attemptId: string,
  notes: string,
  csrfToken: string,
): Promise<PrintAttempt> {
  return apiRequest(`${attemptPath(attemptId)}/notes`, {
    method: 'PUT',
    body: JSON.stringify({ notes }),
    csrfToken,
    headers: { 'idempotency-key': requestKey() },
  });
}

export function uploadPrintPhoto(
  attemptId: string,
  file: File,
  csrfToken: string,
): Promise<PrintPhoto> {
  return apiRequest(`${attemptPath(attemptId)}/photos`, {
    method: 'POST',
    body: file,
    csrfToken,
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'idempotency-key': requestKey(),
      'x-yuki-filename': safeHeaderFilename(file.name),
    },
  });
}

function attemptPath(attemptId: string): string {
  return `/api/v1/printing/print-attempts/${encodeURIComponent(attemptId)}`;
}

function requestKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function safeHeaderFilename(filename: string): string {
  return filename
    .replaceAll(/[^\x20-\x7e]/g, '_')
    .replaceAll(/[\r\n]/g, '_')
    .slice(0, 1024);
}
