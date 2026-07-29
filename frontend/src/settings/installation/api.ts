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
    readonly mode: 'webhook';
    readonly configurable: true;
    readonly apiPath: string;
    readonly message: string;
  };
  readonly configurationSurfaces: {
    readonly printers: { readonly apiPath: string };
    readonly storage: { readonly managedByInstallation: true; readonly exposesSecrets: false };
  };
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface NotificationWebhookConfiguration {
  readonly mode: 'webhook';
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly endpointDisplay: string | null;
  readonly bearerTokenConfigured: boolean;
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface NotificationDelivery {
  readonly id: string;
  readonly notificationId: string;
  readonly kind: string;
  readonly title: string;
  readonly state: 'pending' | 'retrying' | 'succeeded' | 'failed' | 'disabled';
  readonly attemptCount: number;
  readonly responseStatus: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly lastAttemptAt: string | null;
  readonly deliveredAt: string | null;
  readonly updatedAt: string;
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

export const notificationWebhookQueryKey = ['settings', 'notification-webhook'] as const;
export const notificationDeliveriesQueryKey = ['settings', 'notification-deliveries'] as const;

export function getNotificationWebhookConfiguration(): Promise<NotificationWebhookConfiguration> {
  return apiRequest('/api/v1/notifications/webhook-configuration');
}

export function updateNotificationWebhookConfiguration(
  input: {
    readonly enabled: boolean;
    readonly endpointUrl?: string;
    readonly bearerToken?: string;
    readonly clearBearerToken?: boolean;
    readonly expectedVersion: number;
  },
  csrfToken: string,
): Promise<NotificationWebhookConfiguration> {
  return apiRequest('/api/v1/notifications/webhook-configuration', {
    method: 'PATCH',
    csrfToken,
    body: JSON.stringify(input),
  });
}

export function getNotificationDeliveries(): Promise<{
  readonly deliveries: readonly NotificationDelivery[];
}> {
  return apiRequest('/api/v1/notifications/deliveries?limit=5');
}
