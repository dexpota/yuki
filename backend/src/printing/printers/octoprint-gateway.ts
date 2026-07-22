import type { PrinterDestination } from './destination.js';

export type PrinterOperationalState =
  | 'operational'
  | 'printing'
  | 'paused'
  | 'error'
  | 'offline'
  | 'unknown';

export interface VerifiedPrinterConnection {
  readonly online: true;
  readonly state: PrinterOperationalState;
  readonly upstreamVersion: string | null;
}

export type PrinterGatewayFailureKind =
  | 'unauthorized'
  | 'unavailable'
  | 'timeout'
  | 'malformed_response'
  | 'response_too_large';

export class PrinterGatewayError extends Error {
  override readonly name = 'PrinterGatewayError';
  public constructor(
    public readonly kind: PrinterGatewayFailureKind,
    public readonly retryable: boolean,
    message = 'Printer connection verification failed',
  ) {
    super(message);
  }
}

export interface OctoPrintGatewayOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class OctoPrintGateway {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  public constructor(options: OctoPrintGatewayOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
  }

  public async verifyConnection(
    destination: PrinterDestination,
    apiKey: string,
  ): Promise<VerifiedPrinterConnection> {
    const url = new URL('api/connection', destination.baseUrl);
    if (url.origin !== destination.origin) throw new PrinterGatewayError('unavailable', false);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
        throw new PrinterGatewayError('timeout', true);
      throw new PrinterGatewayError('unavailable', true);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403)
      throw new PrinterGatewayError('unauthorized', false);
    if (!response.ok) throw new PrinterGatewayError('unavailable', response.status >= 500);

    const body = await boundedJson(response, this.#maxResponseBytes);
    if (!isObject(body) || !isObject(body.current) || typeof body.current.state !== 'string')
      throw new PrinterGatewayError('malformed_response', false);
    return {
      online: true,
      state: normalizeState(body.current.state),
      upstreamVersion: typeof body.current.version === 'string' ? body.current.version : null,
    };
  }
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit)
    throw new PrinterGatewayError('response_too_large', false);
  if (!response.body) throw new PrinterGatewayError('malformed_response', false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new PrinterGatewayError('response_too_large', false);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PrinterGatewayError('malformed_response', false);
  }
}

function normalizeState(value: string): PrinterOperationalState {
  const state = value.trim().toLowerCase();
  if (state.includes('print')) return 'printing';
  if (state.includes('paus')) return 'paused';
  if (state.includes('operational') || state.includes('ready')) return 'operational';
  if (state.includes('error') || state.includes('closed')) return 'error';
  if (state.includes('offline')) return 'offline';
  return 'unknown';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
