import { isRouteErrorResponse, Link, type RouteObject, useRouteError } from 'react-router';
import { SessionGate } from '../../settings/identity/session.js';
import { AppShell } from './AppShell.js';

function WelcomePage() {
  return (
    <section className="welcome">
      <p className="eyebrow">Your print library</p>
      <h1>Keep every model ready for its next print.</h1>
      <p>Catalogue, import, and printing features will appear here as they are added.</p>
    </section>
  );
}

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
          { index: true, element: <WelcomePage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
