import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LocalImportPage,
  type LocalImportSession,
  uploadLocalImport,
} from '../../src/importing/local/index.js';

class FakeXmlHttpRequest extends EventTarget {
  static last: FakeXmlHttpRequest | undefined;
  static readonly instances: FakeXmlHttpRequest[] = [];
  readonly upload = new EventTarget();
  readonly headers = new Map<string, string>();
  status = 0;
  response: unknown;
  responseType = '';
  withCredentials = false;
  method = '';
  url = '';
  body: Document | XMLHttpRequestBodyInit | null = null;

  constructor() {
    super();
    FakeXmlHttpRequest.last = this;
    FakeXmlHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.body = body;
  }

  abort() {
    this.dispatchEvent(new Event('abort'));
    this.dispatchEvent(new Event('loadend'));
  }

  complete(status: number, response: unknown) {
    this.status = status;
    this.response = response;
    this.dispatchEvent(new Event('load'));
    this.dispatchEvent(new Event('loadend'));
  }
}

beforeEach(() => {
  FakeXmlHttpRequest.last = undefined;
  FakeXmlHttpRequest.instances.length = 0;
  vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('manual import API', () => {
  it('streams a binary upload with progress, CSRF, idempotency, and encoded metadata', async () => {
    const progress = vi.fn();
    const file = new File(['solid model'], 'Café model.stl', { type: 'model/stl' });
    const promise = uploadLocalImport({
      file,
      modelName: 'Café prototype',
      csrfToken: 'csrf-token',
      idempotencyKey: 'idempotency-1',
      onProgress: progress,
    });
    const request = requiredRequest();
    request.upload.dispatchEvent(
      new ProgressEvent('progress', {
        lengthComputable: true,
        loaded: file.size,
        total: file.size,
      }),
    );
    request.complete(202, session({ state: 'queued' }));

    await expect(promise).resolves.toMatchObject({ id: 'import-1', state: 'queued' });
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/v1/imports/local');
    expect(request.withCredentials).toBe(true);
    expect(request.body).toBe(file);
    expect(request.headers.get('content-type')).toBe('application/octet-stream');
    expect(request.headers.get('x-yuki-claimed-mime-type')).toBe('model/stl');
    expect(request.headers.get('x-csrf-token')).toBe('csrf-token');
    expect(request.headers.get('idempotency-key')).toBe('idempotency-1');
    expect(request.headers.get('x-yuki-value-encoding')).toBe('percent');
    expect(request.headers.get('x-yuki-filename')).toBe('Caf%C3%A9%20model.stl');
    expect(request.headers.get('x-yuki-model-name')).toBe('Caf%C3%A9%20prototype');
    expect(progress).toHaveBeenCalledWith(file.size, file.size);
  });
});

describe('manual import page', () => {
  it('retries an interrupted logical upload with the same idempotency key', async () => {
    const view = renderPage();
    const file = new File(['solid model'], 'model.stl', { type: 'model/stl' });
    fireEvent.change(requiredFileInput(view.container), { target: { files: [file] } });
    const submit = screen.getByRole('button', { name: 'Upload and import' });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(FakeXmlHttpRequest.instances).toHaveLength(1));
    const first = FakeXmlHttpRequest.instances[0];
    if (!first) throw new Error('Expected the first upload request');
    first.complete(503, {
      error: { code: 'upload_unavailable', message: 'Upload temporarily unavailable.' },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(FakeXmlHttpRequest.instances).toHaveLength(2));
    expect(FakeXmlHttpRequest.instances[1]?.headers.get('idempotency-key')).toBe(
      first.headers.get('idempotency-key'),
    );
  });

  it('shows reports, collects an exact-duplicate decision, and links to the published model', async () => {
    let duplicatesKept = false;
    const duplicate = session({
      state: 'processing',
      progress: 60,
      files: [
        {
          id: '10000000-0000-4000-8000-000000000001',
          fileKey: '__original__',
          originalFilename: 'Café model.stl',
          isOriginal: true,
          status: 'accepted',
          role: 'geometry',
          format: 'stl',
          detectedMimeType: 'model/stl',
          byteSize: 11,
          checksum: 'a'.repeat(64),
          detection: {},
          warnings: [{ code: 'exact_duplicate', message: 'This content already exists.' }],
          duplicateAssetIds: ['asset-1'],
          duplicateDecision: 'required',
          error: null,
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          duplicatesKept = true;
          return Response.json({
            sessionId: 'import-1',
            decision: 'keep',
            fileIds: ['10000000-0000-4000-8000-000000000001'],
          });
        }
        return Response.json(
          duplicatesKept
            ? session({ state: 'succeeded', progress: 100, modelId: 'model-1' })
            : duplicate,
        );
      }),
    );
    const view = renderPage();
    const file = new File(['solid model'], 'Café model.stl', { type: 'model/stl' });
    fireEvent.change(requiredFileInput(view.container), { target: { files: [file] } });
    expect(screen.getByRole('textbox', { name: 'Model name' })).toHaveValue('Café model');
    const submit = screen.getByRole('button', { name: 'Upload and import' });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(FakeXmlHttpRequest.last).toBeDefined());
    const request = requiredRequest();
    request.upload.dispatchEvent(
      new ProgressEvent('progress', {
        lengthComputable: true,
        loaded: file.size,
        total: file.size,
      }),
    );
    request.complete(202, session({ state: 'queued', progress: 50 }));

    expect(await screen.findByRole('heading', { name: 'Your decision is required' })).toBeVisible();
    expect(screen.getByText('This content already exists.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep duplicate files and continue' }));

    const modelLink = await screen.findByRole('link', { name: 'View imported model' });
    expect(modelLink).toHaveAttribute('href', '/catalogue/models/model-1');
    await waitFor(() => expect(duplicatesKept).toBe(true));
  });
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/import']}>
        <LocalImportPage csrfToken="csrf-token" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function requiredRequest(): FakeXmlHttpRequest {
  if (!FakeXmlHttpRequest.last) throw new Error('Expected an upload request');
  return FakeXmlHttpRequest.last;
}

function requiredFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('Expected a file input');
  return input;
}

function session(overrides: Partial<LocalImportSession> = {}): LocalImportSession {
  return {
    id: 'import-1',
    state: 'queued',
    originalFilename: 'Café model.stl',
    modelName: 'Café model',
    uploadedBytes: 11,
    checksum: 'a'.repeat(64),
    progress: 50,
    modelId: null,
    error: null,
    createdAt: '2026-07-23T10:00:00.000Z',
    updatedAt: '2026-07-23T10:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}
