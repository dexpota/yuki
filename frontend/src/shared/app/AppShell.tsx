import { NavLink, Outlet } from 'react-router';

import { SignOutButton } from '../../settings/identity/SignOutButton.js';
import { useSession } from '../../settings/identity/session.js';

export function AppShell() {
  const session = useSession();

  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink className="brand" to="/" aria-label="Yuki home">
          Yuki
        </NavLink>
        <span className="app-purpose">3D print catalogue</span>
        {session.data?.authenticated === true ? (
          <div className="owner-session">
            <span>{session.data.owner.username}</span>
            <SignOutButton session={session.data} />
          </div>
        ) : null}
      </header>
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}
