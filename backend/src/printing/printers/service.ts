import { randomUUID } from 'node:crypto';

import type { Kysely, Selectable } from 'kysely';

import { type PrinterDestinationPolicy, UnsafePrinterDestinationError } from './destination.js';
import {
  type OctoPrintGateway,
  PrinterGatewayError,
  type VerifiedPrinterConnection,
} from './octoprint-gateway.js';
import {
  normalizePrinterProfile,
  type PrinterProfileInput,
  type PrinterProfileV1,
  parseStoredPrinterProfile,
} from './profile.js';
import type { PrinterDatabaseSchema, PrinterTable } from './schema.js';

export class PrinterNotFoundError extends Error {
  override readonly name = 'PrinterNotFoundError';
}

export class PrinterConflictError extends Error {
  override readonly name = 'PrinterConflictError';
}

export class PrinterConnectionError extends Error {
  override readonly name = 'PrinterConnectionError';
  public constructor(
    public readonly reason:
      | 'destination_rejected'
      | 'unauthorized'
      | 'unavailable'
      | 'timeout'
      | 'malformed_response'
      | 'response_too_large',
    public readonly retryable: boolean,
  ) {
    super('Printer connection verification failed');
  }
}

export interface PrinterSecretVault {
  readonly encrypt: (plaintext: string, purpose: string) => string;
  readonly decrypt: (envelope: string, purpose: string) => string;
}

export interface CreatePrinterInput {
  readonly displayName: string;
  readonly octoprintUrl: string;
  readonly apiKey: string;
  readonly profile: PrinterProfileInput;
}

export interface UpdatePrinterInput {
  readonly displayName?: string;
  readonly octoprintUrl?: string;
  readonly apiKey?: string;
  readonly enabled?: boolean;
  readonly profile?: PrinterProfileInput;
  readonly expectedVersion?: number;
}

export interface PrinterView {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly credentialConfigured: true;
  readonly connectionStatus: 'online' | 'offline' | 'unknown';
  readonly operationalState: string | null;
  readonly profile: PrinterProfileV1;
  readonly verifiedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface PrinterServiceOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export class PrinterService {
  readonly #now: () => Date;
  readonly #newId: () => string;

  public constructor(
    private readonly database: Kysely<PrinterDatabaseSchema>,
    private readonly secrets: PrinterSecretVault,
    private readonly destinations: PrinterDestinationPolicy,
    private readonly gateway: OctoPrintGateway,
    options: PrinterServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
  }

  public async create(ownerId: string, input: CreatePrinterInput): Promise<PrinterView> {
    const id = this.#newId();
    const displayName = validName(input.displayName);
    const apiKey = validApiKey(input.apiKey);
    const profile = normalizePrinterProfile(input.profile);
    const { destination, verification } = await this.verify(input.octoprintUrl, apiKey);
    const now = this.#now();
    try {
      await this.database
        .insertInto('printers')
        .values({
          id,
          owner_id: ownerId,
          display_name: displayName,
          octoprint_url: destination.baseUrl,
          encrypted_api_key: this.secrets.encrypt(apiKey, secretPurpose(ownerId, id)),
          enabled: true,
          connection_status: 'online',
          operational_state: verification.state,
          profile_schema_version: profile.schemaVersion,
          profile,
          created_at: now,
          updated_at: now,
          verified_at: now,
          version: 1,
        })
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isUniqueViolation(error)) throw new PrinterConflictError('Printer name already exists');
      throw error;
    }
    return this.get(ownerId, id);
  }

  public async list(ownerId: string): Promise<readonly PrinterView[]> {
    return (
      await this.database
        .selectFrom('printers')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .orderBy('display_name', 'asc')
        .orderBy('id', 'asc')
        .execute()
    ).map(view);
  }

  public async get(ownerId: string, printerId: string): Promise<PrinterView> {
    const row = await this.database
      .selectFrom('printers')
      .selectAll()
      .where('id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new PrinterNotFoundError('Printer not found');
    return view(row);
  }

  public async update(
    ownerId: string,
    printerId: string,
    input: UpdatePrinterInput,
  ): Promise<PrinterView> {
    if (Object.keys(input).every((key) => key === 'expectedVersion'))
      throw new TypeError('At least one printer field is required');
    const current = await this.ownedRow(ownerId, printerId);
    const displayName =
      input.displayName === undefined ? current.display_name : validName(input.displayName);
    const profile =
      input.profile === undefined
        ? parseStoredPrinterProfile(current.profile)
        : normalizePrinterProfile(input.profile);
    let url = current.octoprint_url;
    let encryptedKey = current.encrypted_api_key;
    let verification: VerifiedPrinterConnection | undefined;
    if (input.octoprintUrl !== undefined || input.apiKey !== undefined) {
      const apiKey =
        input.apiKey === undefined
          ? this.secrets.decrypt(current.encrypted_api_key, secretPurpose(ownerId, printerId))
          : validApiKey(input.apiKey);
      const verified = await this.verify(input.octoprintUrl ?? current.octoprint_url, apiKey);
      url = verified.destination.baseUrl;
      verification = verified.verification;
      if (input.apiKey !== undefined)
        encryptedKey = this.secrets.encrypt(apiKey, secretPurpose(ownerId, printerId));
    }
    const now = this.#now();
    let query = this.database
      .updateTable('printers')
      .set({
        display_name: displayName,
        octoprint_url: url,
        encrypted_api_key: encryptedKey,
        enabled: input.enabled ?? current.enabled,
        profile_schema_version: profile.schemaVersion,
        profile,
        ...(verification === undefined
          ? {}
          : {
              connection_status: 'online' as const,
              operational_state: verification.state,
              verified_at: now,
            }),
        updated_at: now,
        version: current.version + 1,
      })
      .where('id', '=', printerId)
      .where('owner_id', '=', ownerId);
    if (input.expectedVersion !== undefined)
      query = query.where('version', '=', input.expectedVersion);
    try {
      const updated = await query.returning('id').executeTakeFirst();
      if (!updated) throw new PrinterConflictError('Printer was changed by another request');
    } catch (error) {
      if (isUniqueViolation(error)) throw new PrinterConflictError('Printer name already exists');
      throw error;
    }
    return this.get(ownerId, printerId);
  }

  public async verifySaved(ownerId: string, printerId: string): Promise<PrinterView> {
    const current = await this.ownedRow(ownerId, printerId);
    const key = this.secrets.decrypt(current.encrypted_api_key, secretPurpose(ownerId, printerId));
    let verification: VerifiedPrinterConnection;
    try {
      ({ verification } = await this.verify(current.octoprint_url, key));
    } catch (error) {
      if (error instanceof PrinterConnectionError) {
        const failedAt = this.#now();
        await this.database
          .updateTable('printers')
          .set({
            connection_status: 'offline',
            operational_state: null,
            updated_at: failedAt,
            version: current.version + 1,
          })
          .where('id', '=', printerId)
          .where('owner_id', '=', ownerId)
          .executeTakeFirstOrThrow();
      }
      throw error;
    }
    const now = this.#now();
    await this.database
      .updateTable('printers')
      .set({
        connection_status: 'online',
        operational_state: verification.state,
        verified_at: now,
        updated_at: now,
        version: current.version + 1,
      })
      .where('id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow();
    return this.get(ownerId, printerId);
  }

  public async remove(ownerId: string, printerId: string): Promise<void> {
    const deleted = await this.database
      .deleteFrom('printers')
      .where('id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .returning('id')
      .executeTakeFirst();
    if (!deleted) throw new PrinterNotFoundError('Printer not found');
  }

  private async ownedRow(ownerId: string, printerId: string): Promise<Selectable<PrinterTable>> {
    const row = await this.database
      .selectFrom('printers')
      .selectAll()
      .where('id', '=', printerId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new PrinterNotFoundError('Printer not found');
    return row;
  }

  private async verify(url: string, apiKey: string) {
    try {
      const destination = await this.destinations.validate(url);
      const verification = await this.gateway.verifyConnection(destination, apiKey);
      return { destination, verification };
    } catch (error) {
      if (error instanceof UnsafePrinterDestinationError)
        throw new PrinterConnectionError('destination_rejected', false);
      if (error instanceof PrinterGatewayError)
        throw new PrinterConnectionError(error.kind, error.retryable);
      throw error;
    }
  }
}

function view(row: Selectable<PrinterTable>): PrinterView {
  return {
    id: row.id,
    displayName: row.display_name,
    enabled: row.enabled,
    credentialConfigured: true,
    connectionStatus: row.connection_status,
    operationalState: row.operational_state,
    profile: parseStoredPrinterProfile(row.profile),
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function secretPurpose(ownerId: string, printerId: string): string {
  return `octoprint-api-key:${ownerId}:${printerId}`;
}

function validName(value: string): string {
  const result = value.trim();
  if (result.length < 1 || result.length > 200) throw new TypeError('displayName is invalid');
  return result;
}

function validApiKey(value: string): string {
  const result = value.trim();
  if (
    result.length < 1 ||
    result.length > 1024 ||
    [...result].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  )
    throw new TypeError('apiKey is invalid');
  return result;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
