import { isRouteErrorResponse, Link, type RouteObject, useRouteError } from 'react-router';
import { CataloguePage, ModelPage } from '../../catalogue/index.js';
import { SessionGate } from '../../settings/identity/session.js';
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
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
