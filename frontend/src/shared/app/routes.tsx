import { isRouteErrorResponse, Link, type RouteObject, useRouteError } from 'react-router';
import { CataloguePage, ModelPage } from '../../catalogue/index.js';
import { LocalImportPage } from '../../importing/local/index.js';
import { PrintHistoryPage } from '../../printing/history/index.js';
import { SessionGate, useSession } from '../../settings/identity/session.js';
import { InstallationSettingsPage } from '../../settings/installation/index.js';
import { AppShell } from './AppShell.js';

function NotFoundPage() {
  return (
    <section className="route-message">
      <p className="eyebrow">404</p>
      <h1>Page not found</h1>
      <Link to="/">Return home</Link>
    </section>
  );
}

function RouteErrorPage() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : 'The requested page could not be loaded.';

  return (
    <main className="fatal-error" role="alert">
      <p className="eyebrow">Navigation error</p>
      <h1>Something went wrong</h1>
      <p>{message}</p>
      <Link to="/">Return home</Link>
    </main>
  );
}

function InstallationSettingsRoute() {
  const session = useSession();
  if (session.data?.authenticated !== true) return null;
  return <InstallationSettingsPage csrfToken={session.data.csrfToken} />;
}

function LocalImportRoute() {
  const session = useSession();
  if (session.data?.authenticated !== true) return null;
  return <LocalImportPage csrfToken={session.data.csrfToken} />;
}

export const routes: RouteObject[] = [
  {
    element: <SessionGate />,
    errorElement: <RouteErrorPage />,
    children: [
      { path: '/setup', element: null },
      { path: '/sign-in', element: null },
      {
        path: '/',
        element: <AppShell />,
        children: [
          { index: true, element: <CataloguePage /> },
          { path: 'catalogue/models/:modelId', element: <ModelPage /> },
          { path: 'import', element: <LocalImportRoute /> },
          { path: 'history', element: <PrintHistoryPage /> },
          { path: 'settings', element: <InstallationSettingsRoute /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
