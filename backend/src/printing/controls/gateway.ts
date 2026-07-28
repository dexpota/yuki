import type { PrinterDestination } from '../printers/public.js';
import type { PrinterControlAction, PrinterControlParameters } from './contracts.js';

export type PrinterControlFailureKind = 'unauthorized' | 'unavailable' | 'timeout' | 'rejected';

export class PrinterControlGatewayError extends Error {
  override readonly name = 'PrinterControlGatewayError';
  public constructor(
    public readonly kind: PrinterControlFailureKind,
    public readonly ambiguous: boolean,
  ) {
    super('OctoPrint control command failed');
  }
}

export interface PrinterControlGateway {
  readonly execute: (
    destination: PrinterDestination,
    apiKey: string,
    action: PrinterControlAction,
    parameters: PrinterControlParameters,
  ) => Promise<void>;
}

export class OctoPrintControlGateway implements PrinterControlGateway {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  public constructor(options: { readonly fetch?: typeof fetch; readonly timeoutMs?: number } = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  public async execute(
    destination: PrinterDestination,
    apiKey: string,
    action: PrinterControlAction,
    parameters: PrinterControlParameters,
  ): Promise<void> {
    const request = requestFor(action, parameters);
    const url = new URL(request.path, destination.baseUrl);
    if (url.origin !== destination.origin)
      throw new PrinterControlGatewayError('unavailable', false);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'X-Api-Key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(request.body),
        signal: abort.signal,
      });
      if (response.status === 401 || response.status === 403)
        throw new PrinterControlGatewayError('unauthorized', false);
      if (!response.ok)
        throw new PrinterControlGatewayError(
          response.status >= 500 ? 'unavailable' : 'rejected',
          response.status >= 500,
        );
      if (response.body) await response.body.cancel();
    } catch (error) {
      if (error instanceof PrinterControlGatewayError) throw error;
      if (abort.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
        throw new PrinterControlGatewayError('timeout', true);
      throw new PrinterControlGatewayError('unavailable', true);
    } finally {
      clearTimeout(timer);
    }
  }
}

function requestFor(action: PrinterControlAction, parameters: PrinterControlParameters) {
  switch (action) {
    case 'pause':
      return { path: 'api/job', body: { command: 'pause', action: 'pause' } };
    case 'resume':
      return { path: 'api/job', body: { command: 'pause', action: 'resume' } };
    case 'cancel':
      return { path: 'api/job', body: { command: 'cancel' } };
    case 'set_tool_temperature': {
      const value = parameters as { readonly tool: string; readonly targetCelsius: number };
      return {
        path: 'api/printer/tool',
        body: { command: 'target', targets: { [value.tool]: value.targetCelsius } },
      };
    }
    case 'set_bed_temperature':
      return {
        path: 'api/printer/bed',
        body: {
          command: 'target',
          target: (parameters as { readonly targetCelsius: number }).targetCelsius,
        },
      };
    case 'home':
      return {
        path: 'api/printer/printhead',
        body: {
          command: 'home',
          axes: (parameters as { readonly axes: readonly string[] }).axes,
        },
      };
  }
}
