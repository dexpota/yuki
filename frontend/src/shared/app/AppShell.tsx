import { NavLink, Outlet } from 'react-router';

export function AppShell() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink className="brand" to="/" aria-label="Yuki home">
          Yuki
        </NavLink>
        <span className="app-purpose">3D print catalogue</span>
      </header>
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}
