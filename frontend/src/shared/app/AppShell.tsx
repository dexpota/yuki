import { NavLink, Outlet } from 'react-router';

import { useNotifications } from '../../printing/notifications/index.js';
import { SignOutButton } from '../../settings/identity/SignOutButton.js';
import { useSession } from '../../settings/identity/session.js';

export function AppShell() {
  const session = useSession();
  const notifications = useNotifications(false, session.data?.authenticated === true);
  const unreadCount = notifications.data?.unreadCount ?? 0;

  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink className="brand" to="/" aria-label="Yuki home">
          Yuki
        </NavLink>
        <span className="app-purpose">3D print catalogue</span>
        {session.data?.authenticated === true ? (
          <>
            <nav aria-label="Application">
              <NavLink to="/">Catalogue</NavLink>
              <NavLink to="/import">Import</NavLink>
              <NavLink to="/history">History</NavLink>
              <NavLink to="/printers">Printers</NavLink>
              <NavLink className="notification-nav-link" to="/notifications">
                Notifications
                {unreadCount > 0 ? (
                  <>
                    <span className="notification-nav-badge" aria-hidden="true">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                    <span className="notification-badge-label">
                      {unreadCount} unread notifications
                    </span>
                  </>
                ) : null}
              </NavLink>
              <NavLink to="/settings">Settings</NavLink>
            </nav>
            <div className="owner-session">
              <span>{session.data.owner.username}</span>
              <SignOutButton session={session.data} />
            </div>
          </>
        ) : null}
      </header>
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}
