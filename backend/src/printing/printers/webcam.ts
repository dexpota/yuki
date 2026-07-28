import type { Kysely } from 'kysely';

import type { PrinterDestination, PrinterDestinationPolicy } from './destination.js';
import {
  PrinterConnectionError,
  PrinterNotFoundError,
  type PrinterSecretVault,
} from './service.js';
import type { PrinterDatabaseSchema } from './schema.js';

export interface PrinterWebcamSnapshot {
  readonly contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly bytes: Uint8Array;
}

export interface OctoPrintWebcamGatewayOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maximumSettingsBytes?: number;
  readonly maximumSnapshotBytes?: number;
}

export class OctoPrintWebcamGateway {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maximumSettingsBytes: number;
  readonly #maximumSnapshotBytes: number;

  public constructor(options: OctoPrintWebcamGatewayOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    this.#maximumSettingsBytes = options.maximumSettingsBytes ?? 128 * 1024;
    this.#maximumSnapshotBytes = options.maximumSnapshotBytes ?? 10 * 1024 * 1024;
  }

  public async snapshot(
    destination: PrinterDestination,
    apiKey: string,
  ): Promise<PrinterWebcamSnapshot> {
    const settingsUrl = sameOriginUrl('api/settings', destination);
    const settings = await this.request(settingsUrl, apiKey);
    const settingsBody = await boundedBytes(settings, this.#maximumSettingsBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(settingsBody));
    } catch {
      throw webcamError('malformed_response', false);
    }
    const configuredUrl = snapshotUrl(parsed);
    if (configuredUrl === null) throw webcamError('malformed_response', false);

    let target: URL;
    try {
      target = new URL(configuredUrl, destination.baseUrl);
    } catch {
      throw webcamError('destination_rejected', false);
    }
    if (
      target.origin !== destination.origin ||
      !['http:', 'https:'].includes(target.protocol) ||
      target.username !== '' ||
      target.password !== ''
    )
      throw webcamError('destination_rejected', false);

    const response = await this.request(target, apiKey);
    const contentType = normalizeImageContentType(response.headers.get('content-type'));
    if (contentType === null) throw webcamError('malformed_response', false);
    return {
      contentType,
      bytes: await boundedBytes(response, this.#maximumSnapshotBytes),
    };
  }

  private async request(url: URL, apiKey: string): Promise<Response> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: { 'X-Api-Key': apiKey },
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
        throw webcamError('timeout', true);
      throw webcamError('unavailable', true);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403)
      throw webcamError('unauthorized', false);
    if (!response.ok) throw webcamError('unavailable', response.status >= 500);
    return response;
  }
}

export class PrinterWebcamService {
  public constructor(
    private readonly database: Kysely<PrinterDatabaseSchema>,
    private readonly secrets: PrinterSecretVault,
    private readonly destinations: PrinterDestinationPolicy,
    private readonly gateway: OctoPrintWebcamGateway,
  ) {}

  public async snapshot(ownerId: string, printerId: string): Promise<PrinterWebcamSnapshot> {
    const printer = await this.database
      .selectFrom('printers')
      .select(['octoprint_url', 'encrypted_api_key'])
      .where('id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (printer === undefined) throw new PrinterNotFoundError('Printer not found');
    let destination: PrinterDestination;
    try {
      destination = await this.destinations.validate(printer.octoprint_url);
    } catch {
      throw webcamError('destination_rejected', false);
    }
    const apiKey = this.secrets.decrypt(
      printer.encrypted_api_key,
      `octoprint-api-key:${ownerId}:${printerId}`,
    );
    return this.gateway.snapshot(destination, apiKey);
  }
}

function sameOriginUrl(path: string, destination: PrinterDestination): URL {
  const url = new URL(path, destination.baseUrl);
  if (url.origin !== destination.origin) throw webcamError('destination_rejected', false);
  return url;
}

async function boundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes)
    throw webcamError('response_too_large', false);
  if (response.body === null) throw webcamError('malformed_response', false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw webcamError('response_too_large', false);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function snapshotUrl(value: unknown): string | null {
  if (!isObject(value) || !isObject(value.webcam)) return null;
  const direct =
    stringProperty(value.webcam, 'snapshotUrl') ?? stringProperty(value.webcam, 'snapshot');
  if (direct !== null) return direct;
  const webcams = value.webcam.webcams;
  if (!Array.isArray(webcams)) return null;
  for (const webcam of webcams) {
    if (!isObject(webcam)) continue;
    const candidate = stringProperty(webcam, 'snapshotUrl') ?? stringProperty(webcam, 'snapshot');
    if (candidate !== null) return candidate;
  }
  return null;
}

function stringProperty(value: Record<string, unknown>, name: string): string | null {
  const property = value[name];
  return typeof property === 'string' && property.trim() !== '' ? property : null;
}

function normalizeImageContentType(
  value: string | null,
): PrinterWebcamSnapshot['contentType'] | null {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/png' || normalized === 'image/webp')
    return normalized;
  return null;
}

function webcamError(
  reason: ConstructorParameters<typeof PrinterConnectionError>[0],
  retryable: boolean,
): PrinterConnectionError {
  return new PrinterConnectionError(reason, retryable);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
