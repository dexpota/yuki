import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { createBrowserRouter, createMemoryRouter, RouterProvider } from 'react-router';

import { AppErrorBoundary } from './AppErrorBoundary.js';
import { routes } from './routes.js';

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 30_000,
      },
    },
  });
}

const browserQueryClient = createQueryClient();

export function createAppRouter() {
  return createBrowserRouter(routes);
}

export function createTestRouter(initialEntries: string[] = ['/']) {
  return createMemoryRouter(routes, { initialEntries });
}

type AppProvidersProps = {
  children: ReactNode;
  queryClient?: QueryClient;
};

export function AppProviders({ children, queryClient }: AppProvidersProps) {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient ?? browserQueryClient}>
        {children}
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}

export function App() {
  const [router] = useState(createAppRouter);

  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
