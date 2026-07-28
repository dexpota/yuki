import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';

import { useSession } from '../../settings/identity/session.js';
import { markAllNotificationsRead, type Notification, setNotificationRead } from './api.js';
import { notificationsQueryKey, useNotifications } from './queries.js';
import './notifications.css';

export function NotificationsPage() {
  const session = useSession();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const notifications = useNotifications(unreadOnly, session.data?.authenticated === true);
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
  const markAll = useMutation({
    mutationFn: () =>
      markAllNotificationsRead(session.data?.authenticated === true ? session.data.csrfToken : ''),
    onSuccess: () => void invalidate(),
  });

  if (session.data?.authenticated !== true) return null;
  const csrfToken = session.data.csrfToken;
  return (
    <section className="notifications-page">
      <header className="notifications-heading">
        <div>
          <p className="eyebrow">Printing</p>
          <h1>Notifications</h1>
          <p>
            Print results and active-job disconnects appear here within a few seconds. Delivery
            failures never change print state.
          </p>
        </div>
        <div className="notification-heading-actions">
          <label>
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(event) => setUnreadOnly(event.target.checked)}
            />
            <span>Unread only</span>
          </label>
          <button
            type="button"
            disabled={markAll.isPending || (notifications.data?.unreadCount ?? 0) === 0}
            onClick={() => markAll.mutate()}
          >
            Mark all read
          </button>
        </div>
      </header>
      {notifications.isPending ? <p aria-busy="true">Loading notifications…</p> : null}
      {notifications.isError ? (
        <div className="notification-status" role="alert">
          <p>Notifications could not be loaded.</p>
          <button type="button" onClick={() => void notifications.refetch()}>
            Try again
          </button>
        </div>
      ) : null}
      {markAll.isError ? (
        <p className="notification-error" role="alert">
          {markAll.error.message}
        </p>
      ) : null}
      {notifications.data ? (
        <p className="notification-summary" aria-live="polite">
          {notifications.data.unreadCount === 0
            ? 'You are all caught up.'
            : `${notifications.data.unreadCount} unread notification${
                notifications.data.unreadCount === 1 ? '' : 's'
              }.`}
        </p>
      ) : null}
      {notifications.data?.notifications.length === 0 ? (
        <div className="notifications-empty">
          <h2>{unreadOnly ? 'No unread notifications' : 'No notifications yet'}</h2>
          <p>
            {unreadOnly
              ? 'Everything has been reviewed.'
              : 'Print completion, failure, cancellation, and disconnect events will appear here.'}
          </p>
        </div>
      ) : null}
      <ol className="notification-list">
        {(notifications.data?.notifications ?? []).map((notification) => (
          <li key={notification.id}>
            <NotificationCard
              notification={notification}
              csrfToken={csrfToken}
              onChanged={invalidate}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function NotificationCard({
  notification,
  csrfToken,
  onChanged,
}: {
  readonly notification: Notification;
  readonly csrfToken: string;
  readonly onChanged: () => Promise<unknown>;
}) {
  const mutation = useMutation({
    mutationFn: () => setNotificationRead(notification, notification.readAt === null, csrfToken),
    onSuccess: () => void onChanged(),
  });
  return (
    <article
      className={notification.readAt === null ? 'notification-card unread' : 'notification-card'}
    >
      <span className={`notification-icon notification-${notification.kind}`} aria-hidden="true">
        {kindIcon(notification.kind)}
      </span>
      <div>
        <div className="notification-title-row">
          <h2>{notification.title}</h2>
          {notification.readAt === null ? <span className="unread-label">Unread</span> : null}
        </div>
        <p>{notification.message}</p>
        <div className="notification-meta">
          <time dateTime={notification.createdAt}>{formatDateTime(notification.createdAt)}</time>
          {notification.printerId ? (
            <Link to={`/printers/${notification.printerId}`}>Open printer</Link>
          ) : notification.printAttemptId ? (
            <Link to="/history">Open print history</Link>
          ) : null}
        </div>
        <button
          className="notification-read-button"
          type="button"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Mark as {notification.readAt === null ? 'read' : 'unread'}
        </button>
        {mutation.isError ? (
          <p className="notification-error" role="alert">
            {mutation.error.message}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function kindIcon(kind: Notification['kind']): string {
  if (kind === 'print_completed') return '✓';
  if (kind === 'print_cancelled') return '×';
  if (kind === 'printer_disconnected') return '!';
  return '⚠';
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
