import { useQuery } from '@tanstack/react-query';

import { listNotifications } from './api.js';

export const notificationsQueryKey = ['printing', 'notifications'] as const;
export const notificationRefreshIntervalMs = 5_000;

export function useNotifications(unreadOnly = false, enabled = true) {
  return useQuery({
    queryKey: [...notificationsQueryKey, { unreadOnly }],
    queryFn: () => listNotifications(unreadOnly),
    refetchInterval: notificationRefreshIntervalMs,
    enabled,
  });
}
