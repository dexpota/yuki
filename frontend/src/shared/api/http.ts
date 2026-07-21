export interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly requestId?: string;
  };
}

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const sessionExpiredEvent = 'yuki:session-expired';

export interface ApiRequestOptions extends RequestInit {
  readonly csrfToken?: string;
  readonly reportUnauthorized?: boolean;
}

export async function apiRequest<T>(
  path: string,
  { csrfToken, reportUnauthorized = true, ...init }: ApiRequestOptions = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (csrfToken !== undefined) headers.set('x-csrf-token', csrfToken);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, { ...init, credentials: 'include', headers });
  if (!response.ok) {
    const body = await readErrorBody(response);
    if (response.status === 401 && reportUnauthorized) {
      window.dispatchEvent(new Event(sessionExpiredEvent));
    }
    throw new ApiError(
      response.status,
      body.error?.code ?? 'request_failed',
      body.error?.message ?? 'The request could not be completed.',
      body.error?.requestId,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function readErrorBody(response: Response): Promise<ApiErrorBody> {
  try {
    return (await response.json()) as ApiErrorBody;
  } catch {
    return {};
  }
}
