import { apiRequest } from '../../shared/api/http.js';

export type NotificationKind =
  | 'print_completed'
  | 'print_failed'
  | 'print_cancelled'
  | 'printer_disconnected';

export interface Notification {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly printAttemptId: string | null;
  readonly printerId: string | null;
  readonly title: string;
  readonly message: string;
  readonly facts: unknown;
  readonly readAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface NotificationList {
  readonly notifications: readonly Notification[];
  readonly unreadCount: number;
}

export function listNotifications(unreadOnly = false): Promise<NotificationList> {
  const query = new URLSearchParams({ limit: '100' });
  if (unreadOnly) query.set('unread', 'true');
  return apiRequest(`/api/v1/notifications?${query}`);
}

export function setNotificationRead(
  notification: Notification,
  read: boolean,
  csrfToken: string,
): Promise<Notification> {
  return apiRequest(`/api/v1/notifications/${encodeURIComponent(notification.id)}/read-state`, {
    method: 'PUT',
    body: JSON.stringify({ read, expectedVersion: notification.version }),
    csrfToken,
  });
}

export function markAllNotificationsRead(csrfToken: string): Promise<{ readonly updated: number }> {
  return apiRequest('/api/v1/notifications/read-all', {
    method: 'POST',
    csrfToken,
  });
}
