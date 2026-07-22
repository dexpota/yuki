import { apiRequest } from '../../shared/api/http.js';

export interface InstallationSettings {
  readonly limits: {
    readonly uploadMaxBytes: number;
    readonly archiveMaxMembers: number;
    readonly archiveExpandedMaxBytes: number;
    readonly archiveMaxRatio: number;
  };
  readonly retention: {
    readonly trashDays: number;
    readonly jobDays: number;
    readonly observationHistoryEntries: number;
  };
  readonly authentication: { readonly mode: 'password' };
  readonly notifications: {
    readonly mode: 'disabled';
    readonly configurable: false;
    readonly message: string;
  };
  readonly configurationSurfaces: {
    readonly printers: { readonly apiPath: string };
    readonly storage: { readonly managedByInstallation: true; readonly exposesSecrets: false };
  };
  readonly version: number;
  readonly updatedAt: string | null;
}

export const installationSettingsQueryKey = ['settings', 'installation'] as const;

export function getInstallationSettings(): Promise<InstallationSettings> {
  return apiRequest('/api/v1/settings/installation');
}

export function updateInstallationSettings(
  settings: Pick<InstallationSettings, 'limits' | 'retention'>,
  expectedVersion: number,
  csrfToken: string,
): Promise<InstallationSettings> {
  return apiRequest('/api/v1/settings/installation', {
    method: 'PATCH',
    csrfToken,
    body: JSON.stringify({ ...settings, authenticationMode: 'password', expectedVersion }),
  });
}
