import { Readable } from 'node:stream';

import type { PrinterDestination } from '../printers/public.js';

export type PrintCommandPhase = 'folder' | 'upload' | 'verify' | 'start';
export type PrintCommandFailureKind =
  | 'unauthorized'
  | 'unavailable'
  | 'timeout'
  | 'rejected'
  | 'malformed_response';

export class PrintCommandGatewayError extends Error {
  override readonly name = 'PrintCommandGatewayError';
  public constructor(
    public readonly phase: PrintCommandPhase,
    public readonly kind: PrintCommandFailureKind,
    public readonly retryable: boolean,
    public readonly ambiguous: boolean,
  ) {
    super('OctoPrint command failed');
  }
}

export interface PrintUploadInput {
  readonly path: string;
  readonly filename: string;
  readonly byteSize: number;
  readonly checksum: string;
  readonly open: () => Promise<NodeJS.ReadableStream>;
}

export interface PrintCommandGateway {
  readonly ensureUploaded: (
    destination: PrinterDestination,
    apiKey: string,
    input: PrintUploadInput,
  ) => Promise<void>;
  readonly start: (destination: PrinterDestination, apiKey: string, path: string) => Promise<void>;
}

export interface OctoPrintCommandGatewayOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class OctoPrintCommandGateway implements PrintCommandGateway {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  public constructor(options: OctoPrintCommandGatewayOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 128 * 1024;
  }

  public async ensureUploaded(
    destination: PrinterDestination,
    apiKey: string,
    input: PrintUploadInput,
  ): Promise<void> {
    const directory = input.path.slice(0, Math.max(0, input.path.lastIndexOf('/')));
    await this.ensureFolders(destination, apiKey, directory);
    const boundary = `yuki-${crypto.randomUUID()}`;
    const targetDirectory = directory;
    const prefix = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${targetDirectory}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="select"\r\n\r\nfalse\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="print"\r\n\r\nfalse\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quotedFilename(input.filename)}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    );
    const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const source = await input.open();
    const body = Readable.from(
      (async function* () {
        yield prefix;
        for await (const chunk of source) yield chunk;
        yield suffix;
      })(),
    );
    await this.request(destination, apiKey, 'api/files/local', 'upload', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(prefix.byteLength + input.byteSize + suffix.byteLength),
      },
      body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
      duplex: 'half',
    });

    const metadata = await this.request(
      destination,
      apiKey,
      `api/files/local/${encodedPath(input.path)}`,
      'verify',
      { method: 'GET', headers: { accept: 'application/json' } },
    );
    if (!isObject(metadata))
      throw new PrintCommandGatewayError('verify', 'malformed_response', false, false);
    if (metadata.size !== undefined && Number(metadata.size) !== input.byteSize)
      throw new PrintCommandGatewayError('verify', 'rejected', false, false);
    if (
      typeof metadata.hash === 'string' &&
      /^[a-f0-9]{64}$/i.test(metadata.hash) &&
      metadata.hash.toLowerCase() !== input.checksum
    )
      throw new PrintCommandGatewayError('verify', 'rejected', false, false);
  }

  public async start(destination: PrinterDestination, apiKey: string, path: string): Promise<void> {
    await this.request(destination, apiKey, `api/files/local/${encodedPath(path)}`, 'start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'select', print: true }),
    });
  }

  private async ensureFolders(
    destination: PrinterDestination,
    apiKey: string,
    directory: string,
  ): Promise<void> {
    const segments = directory.split('/').filter(Boolean);
    let parent = '';
    for (const foldername of segments) {
      const form = new FormData();
      form.set('foldername', foldername);
      form.set('path', parent);
      try {
        await this.request(destination, apiKey, 'api/files/local', 'folder', {
          method: 'POST',
          body: form,
        });
      } catch (error) {
        if (
          !(error instanceof PrintCommandGatewayError) ||
          error.kind !== 'rejected' ||
          !error.retryable
        )
          throw error;
      }
      parent = parent ? `${parent}/${foldername}` : foldername;
    }
  }

  private async request(
    destination: PrinterDestination,
    apiKey: string,
    relativePath: string,
    phase: PrintCommandPhase,
    init: RequestInit & { readonly duplex?: 'half' },
  ): Promise<unknown> {
    const url = new URL(relativePath, destination.baseUrl);
    if (url.origin !== destination.origin)
      throw new PrintCommandGatewayError(phase, 'unavailable', false, false);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        ...init,
        redirect: 'error',
        headers: { 'X-Api-Key': apiKey, ...init.headers },
        signal: abort.signal,
      } as RequestInit);
      if (response.status === 401 || response.status === 403)
        throw new PrintCommandGatewayError(phase, 'unauthorized', false, false);
      if (!response.ok) {
        const retryable =
          response.status === 409 || response.status === 429 || response.status >= 500;
        throw new PrintCommandGatewayError(
          phase,
          response.status >= 500 ? 'unavailable' : 'rejected',
          retryable,
          phase === 'start' && response.status >= 500,
        );
      }
      if (response.status === 204 || !response.body) return null;
      return boundedJson(response, this.#maxResponseBytes, phase);
    } catch (error) {
      if (error instanceof PrintCommandGatewayError) throw error;
      if (abort.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
        throw new PrintCommandGatewayError(phase, 'timeout', true, phase === 'start');
      throw new PrintCommandGatewayError(phase, 'unavailable', true, phase === 'start');
    } finally {
      clearTimeout(timer);
    }
  }
}

async function boundedJson(
  response: Response,
  limit: number,
  phase: PrintCommandPhase,
): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit)
    throw new PrintCommandGatewayError(phase, 'malformed_response', false, false);
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit)
        throw new PrintCommandGatewayError(phase, 'malformed_response', false, false);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PrintCommandGatewayError(phase, 'malformed_response', false, false);
  }
}

function encodedPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function quotedFilename(filename: string): string {
  return filename.replaceAll(/[\r\n"]/g, '_');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
