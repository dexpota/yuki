import { Component, type ErrorInfo, type ReactNode } from 'react';

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error('An unexpected error occurred.'),
    };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Unhandled application error', error, errorInfo);
  }

  override render() {
    if (this.state.error) {
      return (
        <main className="fatal-error" role="alert">
          <p className="eyebrow">Application error</p>
          <h1>Yuki could not continue</h1>
          <p>Reload the page to try again. Your catalogue data has not been changed.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload Yuki
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}
