import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet } from 'react-router';

import { listCollections, listTags } from '../../catalogue/index.js';
import { useNotifications } from '../../printing/notifications/index.js';
import { SignOutButton } from '../../settings/identity/SignOutButton.js';
import { useSession } from '../../settings/identity/session.js';

export function AppShell() {
  const session = useSession();
  const notifications = useNotifications(false, session.data?.authenticated === true);
  const collections = useQuery({
    queryKey: ['catalogue', 'collections'],
    queryFn: listCollections,
    enabled: session.data?.authenticated === true,
  });
  const tags = useQuery({
    queryKey: ['catalogue', 'tags'],
    queryFn: listTags,
    enabled: session.data?.authenticated === true,
  });
  const unreadCount = notifications.data?.unreadCount ?? 0;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand-lockup">
          <NavLink className="brand" to="/" aria-label="Yuki home">
            Yuki<span className="brand-period">.</span>
          </NavLink>
          <span className="app-purpose">
            SELF-HOSTED
            <br />
            FOR 3D PRINTING
          </span>
        </div>
        {session.data?.authenticated === true ? (
          <div className="owner-session">
            <span className="self-hosted-label">Self-hosted</span>
            <span className="owner-name">{session.data.owner.username}</span>
            <SignOutButton session={session.data} />
          </div>
        ) : null}
      </header>
      <div className="app-layout">
        {session.data?.authenticated === true ? (
          <aside className="app-sidebar">
            <nav className="primary-navigation" aria-label="Application">
              <NavLink className="sidebar-link" end to="/">
                <span className="sidebar-symbol symbol-catalogue" aria-hidden="true" />
                Catalogue
              </NavLink>
              <NavLink className="sidebar-link" to="/import">
                <span className="sidebar-symbol symbol-import" aria-hidden="true" />
                Import
              </NavLink>
              <NavLink className="sidebar-link" to="/printers">
                <span className="sidebar-symbol symbol-printers" aria-hidden="true" />
                Printers
              </NavLink>
              <NavLink className="sidebar-link" to="/history">
                <span className="sidebar-symbol symbol-history" aria-hidden="true" />
                Print history
              </NavLink>
              <NavLink className="sidebar-link notification-nav-link" to="/notifications">
                <span className="sidebar-symbol symbol-notifications" aria-hidden="true" />
                <span>Notifications</span>
                {unreadCount > 0 ? (
                  <span className="notification-nav-badge">
                    <span aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span>
                    <span className="visually-hidden">
                      {unreadCount} unread {unreadCount === 1 ? 'notification' : 'notifications'}
                    </span>
                  </span>
                ) : null}
              </NavLink>
              <NavLink className="sidebar-link" to="/settings">
                <span className="sidebar-symbol symbol-settings" aria-hidden="true" />
                Settings
              </NavLink>
            </nav>
            <SidebarGroup title="Collections" items={collections.data ?? []} param="collectionId" />
            <SidebarGroup title="Tags" items={tags.data ?? []} param="tagId" />
          </aside>
        ) : null}
        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function SidebarGroup({
  title,
  items,
  param,
}: {
  readonly title: string;
  readonly items: readonly { readonly id: string; readonly name: string }[];
  readonly param: 'collectionId' | 'tagId';
}) {
  if (items.length === 0) return null;
  return (
    <section className="sidebar-group" aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {items.slice(0, 6).map((item) => (
          <li key={item.id}>
            <Link to={`/?${param}=${encodeURIComponent(item.id)}`}>
              <span className="sidebar-symbol symbol-collection" aria-hidden="true" />
              {item.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
