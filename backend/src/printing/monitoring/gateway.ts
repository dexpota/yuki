import type { PrinterDestination } from '../printers/public.js';

export type MonitoredPrinterState =
  | 'operational'
  | 'printing'
  | 'paused'
  | 'error'
  | 'offline'
  | 'unknown';

export type ActiveJobIdentity =
  | { readonly kind: 'none' }
  | { readonly kind: 'local'; readonly applicationJobId: string }
  | { readonly kind: 'external' }
  | { readonly kind: 'ambiguous' };

export interface TemperatureObservation {
  readonly component: string;
  readonly actualCelsius: number | null;
  readonly targetCelsius: number | null;
}

export interface PrinterFacts {
  readonly state: MonitoredPrinterState;
  readonly activeJob: ActiveJobIdentity;
  readonly upstreamFile: {
    readonly name: string | null;
    readonly path: string | null;
    readonly origin: string | null;
  };
  readonly progressPercent: number | null;
  readonly elapsedSeconds: number | null;
  readonly remainingSeconds: number | null;
  readonly temperatures: readonly TemperatureObservation[];
}

export type MonitoringGatewayFailureKind =
  | 'unauthorized'
  | 'unavailable'
  | 'timeout'
  | 'malformed_response'
  | 'response_too_large';

export class MonitoringGatewayError extends Error {
  override readonly name = 'MonitoringGatewayError';
  public constructor(
    public readonly kind: MonitoringGatewayFailureKind,
    public readonly retryable: boolean,
  ) {
    super('Printer monitoring request failed');
  }
}

export interface MonitoringGateway {
  readonly observe: (destination: PrinterDestination, apiKey: string) => Promise<PrinterFacts>;
}

export interface OctoPrintMonitoringGatewayOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const applicationJobPattern =
  /^yuki\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/|$)/i;

export function applicationJobPath(jobId: string, filename: string): string {
  if (!applicationJobPattern.test(`yuki/jobs/${jobId}/`)) throw new TypeError('jobId is invalid');
  const safeName = filename.trim().replaceAll('\\', '/').split('/').at(-1)?.trim();
  if (!safeName || safeName === '.' || safeName === '..' || safeName.length > 240)
    throw new TypeError('filename is invalid');
  return `yuki/jobs/${jobId}/${safeName}`;
}

export function applicationJobIdFromPath(path: string | null): string | null {
  return path?.match(applicationJobPattern)?.[1]?.toLowerCase() ?? null;
}

export class OctoPrintMonitoringGateway implements MonitoringGateway {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  public constructor(options: OctoPrintMonitoringGatewayOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 128 * 1024;
  }

  public async observe(destination: PrinterDestination, apiKey: string): Promise<PrinterFacts> {
    const job = await this.request(destination, apiKey, 'api/job');
    const printer = await this.request(destination, apiKey, 'api/printer');
    return normalizeFacts(job, printer);
  }

  private async request(
    destination: PrinterDestination,
    apiKey: string,
    relativePath: string,
  ): Promise<unknown> {
    const url = new URL(relativePath, destination.baseUrl);
    if (url.origin !== destination.origin) throw new MonitoringGatewayError('unavailable', false);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
        signal: abort.signal,
      });
      if (response.status === 401 || response.status === 403)
        throw new MonitoringGatewayError('unauthorized', false);
      if (!response.ok)
        throw new MonitoringGatewayError(
          'unavailable',
          response.status >= 500 || response.status === 429,
        );
      return await boundedJson(response, this.#maxResponseBytes);
    } catch (error) {
      if (error instanceof MonitoringGatewayError) throw error;
      if (abort.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
        throw new MonitoringGatewayError('timeout', true);
      throw new MonitoringGatewayError('unavailable', true);
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeFacts(jobValue: unknown, printerValue: unknown): PrinterFacts {
  if (!isObject(jobValue) || !isObject(printerValue))
    throw new MonitoringGatewayError('malformed_response', false);
  const job = isObject(jobValue.job) ? jobValue.job : {};
  const file = isObject(job.file) ? job.file : {};
  const progress = isObject(jobValue.progress) ? jobValue.progress : {};
  const printerState = isObject(printerValue.state) ? printerValue.state : {};
  const stateText = stringOrNull(jobValue.state) ?? stringOrNull(printerState.text);
  if (stateText === null) throw new MonitoringGatewayError('malformed_response', false);
  const state = normalizeState(stateText);
  const path = boundedString(file.path);
  const name = boundedString(file.name);
  const origin = boundedString(file.origin);
  return {
    state,
    activeJob: classifyActiveJob(state, path, name, origin),
    upstreamFile: { name, path, origin },
    progressPercent: boundedNumber(progress.completion, 0, 100),
    elapsedSeconds: boundedNumber(progress.printTime, 0, Number.MAX_SAFE_INTEGER),
    remainingSeconds: boundedNumber(progress.printTimeLeft, 0, Number.MAX_SAFE_INTEGER),
    temperatures: normalizeTemperatures(printerValue.temperature),
  };
}

function classifyActiveJob(
  state: MonitoredPrinterState,
  path: string | null,
  name: string | null,
  origin: string | null,
): ActiveJobIdentity {
  if (state !== 'printing' && state !== 'paused') return { kind: 'none' };
  const applicationJobId = applicationJobIdFromPath(path);
  if (applicationJobId !== null) return { kind: 'local', applicationJobId };
  if (path !== null || name !== null || origin !== null) return { kind: 'external' };
  return { kind: 'ambiguous' };
}

function normalizeTemperatures(value: unknown): readonly TemperatureObservation[] {
  if (!isObject(value)) return [];
  return Object.entries(value)
    .filter(
      (entry): entry is [string, Record<string, unknown>] =>
        entry[0].length <= 64 && isObject(entry[1]),
    )
    .slice(0, 16)
    .map(([component, facts]) => ({
      component,
      actualCelsius: boundedNumber(facts.actual, -273.15, 1_000),
      targetCelsius: boundedNumber(facts.target, 0, 1_000),
    }));
}

function normalizeState(value: string): MonitoredPrinterState {
  const state = value.trim().toLowerCase();
  if (state.includes('paus')) return 'paused';
  if (state.includes('print')) return 'printing';
  if (state.includes('operational') || state.includes('ready')) return 'operational';
  if (state.includes('error') || state.includes('closed')) return 'error';
  if (state.includes('offline')) return 'offline';
  return 'unknown';
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit)
    throw new MonitoringGatewayError('response_too_large', false);
  if (!response.body) throw new MonitoringGatewayError('malformed_response', false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new MonitoringGatewayError('response_too_large', false);
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
    throw new MonitoringGatewayError('malformed_response', false);
  }
}

function boundedString(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 1_024 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 1_024 ? value : null;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
