import type { Kysely } from 'kysely';

import type { BlobStore } from '../../platform/storage/index.js';
import { applicationJobPath, type MonitoringGateway } from '../monitoring/index.js';
import {
  type PrinterDestination,
  type PrinterDestinationPolicy,
  type PrinterSecretVault,
  UnsafePrinterDestinationError,
} from '../printers/public.js';
import type { PrintStartDatabaseSchema } from './contracts.js';
import {
  type PrintCommandFailureKind,
  type PrintCommandGateway,
  PrintCommandGatewayError,
} from './gateway.js';

export class PrintStartCommandError extends Error {
  override readonly name = 'PrintStartCommandError';
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super('Print start command failed');
  }
}

export class PrintStartCommandService {
  public constructor(
    private readonly database: Kysely<PrintStartDatabaseSchema>,
    private readonly blobStore: BlobStore,
    private readonly secrets: PrinterSecretVault,
    private readonly destinations: PrinterDestinationPolicy,
    private readonly gateway: PrintCommandGateway,
    private readonly monitoring: MonitoringGateway,
  ) {}

  public async execute(ownerId: string, queueEntryId: string): Promise<void> {
    const source = await this.source(ownerId, queueEntryId);
    if (source.state === 'printing' || source.state === 'reconciliation_required') return;
    const path = source.upstream_path ?? applicationJobPath(queueEntryId, source.original_filename);
    let destination: PrinterDestination;
    let apiKey: string;
    try {
      destination = await this.destinations.validate(source.octoprint_url);
      apiKey = this.secrets.decrypt(
        source.encrypted_api_key,
        `octoprint-api-key:${ownerId}:${source.printer_id}`,
      );
    } catch (error) {
      if (error instanceof UnsafePrinterDestinationError) {
        await this.fail(ownerId, queueEntryId, 'destination_rejected');
        throw new PrintStartCommandError('destination_rejected', false);
      }
      await this.fail(ownerId, queueEntryId, 'printer_credentials_unavailable');
      throw new PrintStartCommandError('printer_credentials_unavailable', false);
    }

    const before = await this.observe(destination, apiKey);
    if (before.activeJob.kind === 'local' && before.activeJob.applicationJobId === queueEntryId) {
      await this.markPrinting(ownerId, queueEntryId, path);
      return;
    }
    if (before.activeJob.kind !== 'none') {
      await this.requireReconciliation(ownerId, queueEntryId, path, 'printer_job_conflict');
      return;
    }

    try {
      if (source.state === 'uploading') {
        await this.gateway.ensureUploaded(destination, apiKey, {
          path,
          filename: source.original_filename,
          byteSize: safeSize(source.byte_size),
          checksum: source.checksum,
          open: () => this.blobStore.read(source.object_key),
        });
        await this.markState(ownerId, queueEntryId, 'uploaded', path);
      }
      await this.markState(ownerId, queueEntryId, 'starting', path);
      await this.gateway.start(destination, apiKey, path);
      await this.markPrinting(ownerId, queueEntryId, path);
    } catch (error) {
      if (!(error instanceof PrintCommandGatewayError)) throw error;
      if (error.ambiguous) {
        const reconciled = await this.observe(destination, apiKey);
        if (
          reconciled.activeJob.kind === 'local' &&
          reconciled.activeJob.applicationJobId === queueEntryId
        ) {
          await this.markPrinting(ownerId, queueEntryId, path);
          return;
        }
        if (reconciled.activeJob.kind !== 'none') {
          await this.requireReconciliation(ownerId, queueEntryId, path, 'ambiguous_start_result');
          return;
        }
      }
      if (!error.retryable)
        await this.fail(ownerId, queueEntryId, `octoprint_${error.phase}_${error.kind}`);
      throw commandFailure(error.kind, error.retryable);
    }
  }

  public async abandon(ownerId: string, queueEntryId: string, code: string): Promise<void> {
    await this.fail(ownerId, queueEntryId, code);
  }

  private async observe(destination: Parameters<MonitoringGateway['observe']>[0], apiKey: string) {
    try {
      return await this.monitoring.observe(destination, apiKey);
    } catch {
      throw new PrintStartCommandError('printer_observation_failed', true);
    }
  }

  private async source(ownerId: string, queueEntryId: string) {
    const row = await this.database
      .selectFrom('printing_queue_entries as entry')
      .innerJoin('printers as printer', 'printer.id', 'entry.printer_id')
      .innerJoin('catalogue_assets as asset', 'asset.id', 'entry.asset_id')
      .innerJoin('stored_objects as object', 'object.id', 'asset.stored_object_id')
      .select([
        'entry.state',
        'entry.printer_id',
        'entry.print_attempt_id',
        'entry.upstream_path',
        'printer.octoprint_url',
        'printer.encrypted_api_key',
        'asset.original_filename',
        'asset.byte_size',
        'asset.checksum',
        'object.object_key',
      ])
      .where('entry.id', '=', queueEntryId)
      .where('entry.owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!row?.print_attempt_id) throw new PrintStartCommandError('print_start_not_found', false);
    if (!['uploading', 'uploaded', 'starting'].includes(row.state)) {
      if (row.state === 'printing' || row.state === 'reconciliation_required') return row;
      throw new PrintStartCommandError('print_start_state_invalid', false);
    }
    return row;
  }

  private async markState(
    ownerId: string,
    queueEntryId: string,
    state: 'uploaded' | 'starting',
    path: string,
  ): Promise<void> {
    await this.database
      .updateTable('printing_queue_entries')
      .set((expression) => ({
        state,
        upstream_path: path,
        updated_at: new Date(),
        version: expression('version', '+', 1),
      }))
      .where('id', '=', queueEntryId)
      .where('owner_id', '=', ownerId)
      .where(
        'state',
        'in',
        state === 'uploaded' ? ['uploading'] : ['uploading', 'uploaded', 'starting'],
      )
      .executeTakeFirstOrThrow();
  }

  private async markPrinting(ownerId: string, queueEntryId: string, path: string): Promise<void> {
    const now = new Date();
    await this.database.transaction().execute(async (transaction) => {
      const entry = await transaction
        .updateTable('printing_queue_entries')
        .set((expression) => ({
          state: 'printing',
          upstream_path: path,
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('id', '=', queueEntryId)
        .where('owner_id', '=', ownerId)
        .returning('print_attempt_id')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('print_attempts')
        .set((expression) => ({
          state: 'printing',
          started_at: now,
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('id', '=', entry.print_attempt_id as string)
        .executeTakeFirstOrThrow();
    });
  }

  private async requireReconciliation(
    ownerId: string,
    queueEntryId: string,
    path: string,
    code: string,
  ): Promise<void> {
    const now = new Date();
    await this.database.transaction().execute(async (transaction) => {
      const entry = await transaction
        .updateTable('printing_queue_entries')
        .set((expression) => ({
          state: 'reconciliation_required',
          upstream_path: path,
          error_code: code,
          error_message: 'Printer state must be reconciled before another command.',
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('id', '=', queueEntryId)
        .where('owner_id', '=', ownerId)
        .returning('print_attempt_id')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('print_attempts')
        .set((expression) => ({
          state: 'reconciliation_required',
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('id', '=', entry.print_attempt_id as string)
        .executeTakeFirstOrThrow();
    });
  }

  private async fail(ownerId: string, queueEntryId: string, code: string): Promise<void> {
    const now = new Date();
    await this.database.transaction().execute(async (transaction) => {
      const entry = await transaction
        .updateTable('printing_queue_entries')
        .set((expression) => ({
          state: 'failed',
          error_code: code,
          error_message: 'The printer rejected the remote start command.',
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('id', '=', queueEntryId)
        .where('owner_id', '=', ownerId)
        .returning('print_attempt_id')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('print_attempts')
        .set((expression) => ({
          state: 'failed',
          outcome: 'failed',
          completed_at: now,
          updated_at: now,
          version: expression('version', '+', 1),
        }))
        .where('id', '=', entry.print_attempt_id as string)
        .executeTakeFirstOrThrow();
    });
  }
}

function commandFailure(kind: PrintCommandFailureKind, retryable: boolean) {
  return new PrintStartCommandError(`octoprint_${kind}`, retryable);
}

function safeSize(value: string | number | bigint): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Asset size is invalid.');
  return size;
}
