import { apiRequest } from '../../shared/api/http.js';

export interface PrintPlanEntry {
  readonly id: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly versionId: string;
  readonly versionLabel: string;
  readonly assets: readonly { readonly id: string; readonly filename: string }[];
  readonly position: number;
  readonly unavailable: boolean;
  readonly createdAt: string;
}

export interface PrintPlan {
  readonly entries: readonly PrintPlanEntry[];
}

export function getPrintPlan(): Promise<PrintPlan> {
  return apiRequest('/api/v1/printing/plan');
}

export function addToPrintPlan(
  modelId: string,
  versionId: string,
  csrfToken: string,
): Promise<PrintPlanEntry> {
  return apiRequest('/api/v1/printing/plan', {
    method: 'POST',
    body: JSON.stringify({ modelId, versionId }),
    csrfToken,
  });
}

export function orderPrintPlan(entryIds: readonly string[], csrfToken: string): Promise<PrintPlan> {
  return apiRequest('/api/v1/printing/plan/order', {
    method: 'PUT',
    body: JSON.stringify({ entryIds }),
    csrfToken,
  });
}

export function removeFromPrintPlan(entryId: string, csrfToken: string): Promise<void> {
  return apiRequest(`/api/v1/printing/plan/${encodeURIComponent(entryId)}`, {
    method: 'DELETE',
    csrfToken,
  });
}
