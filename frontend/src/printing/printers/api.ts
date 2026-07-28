import { apiRequest } from '../../shared/api/http.js';

export interface PrinterProfile {
  readonly schemaVersion: 1;
  readonly buildVolume: {
    readonly shape: 'rectangular' | 'circular';
    readonly origin: 'lowerleft' | 'center';
    readonly widthMm: number;
    readonly depthMm: number;
    readonly heightMm: number;
  };
  readonly compatibility: {
    readonly gcodeFlavors: readonly string[];
    readonly nozzleDiameterMm: number | null;
    readonly extruderCount: number;
  };
}

export interface Printer {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly credentialConfigured: true;
  readonly connectionStatus: 'online' | 'offline' | 'unknown';
  readonly operationalState: string | null;
  readonly profile: PrinterProfile;
  readonly verifiedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface PrinterInput {
  readonly displayName: string;
  readonly octoprintUrl?: string;
  readonly apiKey?: string;
  readonly enabled?: boolean;
  readonly profile: Omit<PrinterProfile, 'schemaVersion'>;
  readonly expectedVersion?: number;
}

export interface TemperatureObservation {
  readonly component: string;
  readonly actualCelsius: number | null;
  readonly targetCelsius: number | null;
}

export interface PrinterObservation {
  readonly id: string;
  readonly observedAt: string;
  readonly reason: string;
  readonly online: boolean;
  readonly operationalState: string | null;
  readonly activeJob: {
    readonly kind: 'none' | 'local' | 'external' | 'ambiguous';
    readonly applicationJobId: string | null;
    readonly upstreamFileName: string | null;
    readonly upstreamFilePath: string | null;
    readonly upstreamFileOrigin: string | null;
  };
  readonly progressPercent: number | null;
  readonly elapsedSeconds: number | null;
  readonly remainingSeconds: number | null;
  readonly temperatures: readonly TemperatureObservation[];
  readonly failureKind: string | null;
}

export interface PrinterMonitoring {
  readonly printerId: string;
  readonly freshness: 'fresh' | 'stale' | 'never_observed';
  readonly stale: boolean;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly consecutiveFailures: number;
  readonly reconciliationState: string;
  readonly current: PrinterObservation | null;
  readonly lastGood: PrinterObservation | null;
}

export type CompatibilityStatus = 'compatible' | 'warning' | 'unknown' | 'incompatible';

export interface CompatibilityCheck {
  readonly rule: string;
  readonly status: string;
  readonly code: string;
  readonly message: string;
}

export interface CompatibilitySnapshot {
  readonly result?: {
    readonly status?: CompatibilityStatus;
    readonly blocksByDefault?: boolean;
    readonly canOverride?: boolean;
    readonly checks?: readonly CompatibilityCheck[];
  };
}

export interface QueueEntry {
  readonly id: string;
  readonly printerId: string;
  readonly assetId: string;
  readonly state: string;
  readonly position: number | null;
  readonly compatibilityStatus: CompatibilityStatus | null;
  readonly compatibilitySnapshot: CompatibilitySnapshot | null;
  readonly overrideJustification: string | null;
  readonly printAttemptId: string | null;
  readonly upstreamPath: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface StartChallenge {
  readonly token: string;
  readonly expiresAt: string;
  readonly printer: { readonly id: string; readonly name: string };
  readonly file: { readonly assetId: string; readonly filename: string; readonly byteSize: number };
  readonly compatibilityStatus: string;
  readonly warnings: readonly string[];
  readonly safetyNotice: string;
}

export type ControlAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'set_tool_temperature'
  | 'set_bed_temperature'
  | 'home';

export interface ControlRequest {
  readonly action: ControlAction;
  readonly queueEntryId?: string;
  readonly tool?: string;
  readonly targetCelsius?: number;
  readonly axes?: readonly string[];
}

export interface ControlChallenge {
  readonly token: string;
  readonly expiresAt: string;
  readonly action: ControlAction;
  readonly printer: { readonly id: string; readonly name: string };
  readonly queueEntryId: string | null;
  readonly parameters: unknown;
  readonly safetyNotice: string;
}

export function listPrinters(): Promise<readonly Printer[]> {
  return apiRequest('/api/v1/printing/printers');
}

export function createPrinter(input: PrinterInput, csrfToken: string): Promise<Printer> {
  return apiRequest('/api/v1/printing/printers', {
    method: 'POST',
    body: JSON.stringify(input),
    csrfToken,
  });
}

export function updatePrinter(
  printerId: string,
  input: PrinterInput,
  csrfToken: string,
): Promise<Printer> {
  return apiRequest(printerPath(printerId), {
    method: 'PATCH',
    body: JSON.stringify(input),
    csrfToken,
  });
}

export function verifyPrinter(printerId: string, csrfToken: string): Promise<Printer> {
  return apiRequest(`${printerPath(printerId)}/verify`, { method: 'POST', csrfToken });
}

export function removePrinter(printerId: string, csrfToken: string): Promise<void> {
  return apiRequest(printerPath(printerId), { method: 'DELETE', csrfToken });
}

export function getMonitoring(printerId: string): Promise<PrinterMonitoring> {
  return apiRequest(`${printerPath(printerId)}/monitoring`);
}

export function listQueue(printerId: string): Promise<{ readonly entries: readonly QueueEntry[] }> {
  return apiRequest(`${printerPath(printerId)}/queue`);
}

export function addToQueue(
  printerId: string,
  assetId: string,
  csrfToken: string,
): Promise<QueueEntry> {
  return apiRequest(`${printerPath(printerId)}/queue`, {
    method: 'POST',
    body: JSON.stringify({ assetId }),
    csrfToken,
    headers: { 'idempotency-key': requestKey() },
  });
}

export function reorderQueue(
  printerId: string,
  entryIds: readonly string[],
  csrfToken: string,
): Promise<{ readonly entries: readonly QueueEntry[] }> {
  return apiRequest(`${printerPath(printerId)}/queue/order`, {
    method: 'PUT',
    body: JSON.stringify({ entryIds }),
    csrfToken,
  });
}

export function overrideQueueEntry(
  printerId: string,
  entryId: string,
  justification: string,
  csrfToken: string,
): Promise<QueueEntry> {
  return apiRequest(`${printerPath(printerId)}/queue/${encodeURIComponent(entryId)}/override`, {
    method: 'POST',
    body: JSON.stringify({ justification }),
    csrfToken,
  });
}

export function removeQueueEntry(
  printerId: string,
  entryId: string,
  csrfToken: string,
): Promise<void> {
  return apiRequest(`${printerPath(printerId)}/queue/${encodeURIComponent(entryId)}`, {
    method: 'DELETE',
    csrfToken,
  });
}

export function issueStart(entryId: string, csrfToken: string): Promise<StartChallenge> {
  return apiRequest(
    `/api/v1/printing/print-jobs/${encodeURIComponent(entryId)}/start-confirmations`,
    {
      method: 'POST',
      csrfToken,
    },
  );
}

export function acceptStart(
  entryId: string,
  token: string,
  csrfToken: string,
): Promise<{
  readonly queueEntryId: string;
  readonly printAttemptId: string;
  readonly state: string;
}> {
  return apiRequest(`/api/v1/printing/print-jobs/${encodeURIComponent(entryId)}/start`, {
    method: 'POST',
    body: JSON.stringify({ confirmationToken: token }),
    csrfToken,
    headers: { 'idempotency-key': requestKey() },
  });
}

export function issueControl(
  printerId: string,
  request: ControlRequest,
  csrfToken: string,
): Promise<ControlChallenge> {
  return apiRequest(`${printerPath(printerId)}/control-confirmations`, {
    method: 'POST',
    body: JSON.stringify(request),
    csrfToken,
  });
}

export function acceptControl(
  printerId: string,
  token: string,
  csrfToken: string,
): Promise<{ readonly commandId: string; readonly state: string }> {
  return apiRequest(`${printerPath(printerId)}/controls`, {
    method: 'POST',
    body: JSON.stringify({ confirmationToken: token }),
    csrfToken,
    headers: { 'idempotency-key': requestKey() },
  });
}

export function webcamSnapshotUrl(printerId: string, revision: number): string {
  return `${printerPath(printerId)}/webcam/snapshot?revision=${revision}`;
}

export function printerEventsUrl(printerId: string): string {
  return `${printerPath(printerId)}/events`;
}

function printerPath(printerId: string): string {
  return `/api/v1/printing/printers/${encodeURIComponent(printerId)}`;
}

function requestKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
