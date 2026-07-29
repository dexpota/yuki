import type { Kysely, Selectable } from 'kysely';

import type { InstallationSettingsTable, SettingsDatabaseSchema } from './schema.js';

export class SettingsConflictError extends Error {
  override readonly name = 'SettingsConflictError';
}

export interface InstallationSettingsView {
  readonly limits: {
    readonly uploadMaxBytes: number;
    readonly archiveMaxMembers: number;
    readonly archiveExpandedMaxBytes: number;
    readonly archiveMaxRatio: number;
  };
  readonly retention: {
    readonly trashDays: number;
    readonly jobDays: number;
    readonly observationHistoryEntries: number;
  };
  readonly authentication: { readonly mode: 'password' };
  readonly notifications: {
    readonly mode: 'webhook';
    readonly configurable: true;
    readonly apiPath: '/api/v1/notifications/webhook-configuration';
    readonly message: string;
  };
  readonly configurationSurfaces: {
    readonly printers: { readonly apiPath: '/api/v1/printing/printers' };
    readonly storage: { readonly managedByInstallation: true; readonly exposesSecrets: false };
  };
  readonly version: number;
  readonly updatedAt: Date | null;
}

export interface UpdateInstallationSettings {
  readonly limits?: {
    readonly uploadMaxBytes: number;
    readonly archiveMaxMembers: number;
    readonly archiveExpandedMaxBytes: number;
    readonly archiveMaxRatio: number;
  };
  readonly retention?: {
    readonly trashDays: number;
    readonly jobDays: number;
    readonly observationHistoryEntries: number;
  };
  readonly authenticationMode?: 'password';
  readonly expectedVersion: number;
}

const defaults = {
  uploadMaxBytes: 2 * 1024 ** 3,
  archiveMaxMembers: 1_000,
  archiveExpandedMaxBytes: 10 * 1024 ** 3,
  archiveMaxRatio: 200,
  trashDays: 30,
  jobDays: 90,
  observationHistoryEntries: 120,
} as const;

export class InstallationSettingsService {
  public constructor(
    private readonly database: Kysely<SettingsDatabaseSchema>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async get(ownerId: string): Promise<InstallationSettingsView> {
    const row = await this.database
      .selectFrom('installation_settings')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row ? view(row) : defaultView();
  }

  public async update(
    ownerId: string,
    input: UpdateInstallationSettings,
  ): Promise<InstallationSettingsView> {
    const current = await this.database
      .selectFrom('installation_settings')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    const currentView = current ? view(current) : defaultView();
    if (input.expectedVersion !== currentView.version)
      throw new SettingsConflictError('Settings were changed by another request');
    const limits = validateLimits(input.limits ?? currentView.limits);
    const retention = validateRetention(input.retention ?? currentView.retention);
    if (input.authenticationMode !== undefined && input.authenticationMode !== 'password')
      throw new TypeError('authenticationMode is unsupported');
    const now = this.now();
    if (!current) {
      try {
        await this.database
          .insertInto('installation_settings')
          .values({
            owner_id: ownerId,
            upload_max_bytes: limits.uploadMaxBytes,
            archive_max_members: limits.archiveMaxMembers,
            archive_expanded_max_bytes: limits.archiveExpandedMaxBytes,
            archive_max_ratio: limits.archiveMaxRatio,
            trash_retention_days: retention.trashDays,
            job_retention_days: retention.jobDays,
            observation_history_entries: retention.observationHistoryEntries,
            authentication_mode: 'password',
            created_at: now,
            updated_at: now,
            version: 1,
          })
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error))
          throw new SettingsConflictError('Settings were changed by another request');
        throw error;
      }
    } else {
      const changed = await this.database
        .updateTable('installation_settings')
        .set({
          upload_max_bytes: limits.uploadMaxBytes,
          archive_max_members: limits.archiveMaxMembers,
          archive_expanded_max_bytes: limits.archiveExpandedMaxBytes,
          archive_max_ratio: limits.archiveMaxRatio,
          trash_retention_days: retention.trashDays,
          job_retention_days: retention.jobDays,
          observation_history_entries: retention.observationHistoryEntries,
          updated_at: now,
          version: current.version + 1,
        })
        .where('owner_id', '=', ownerId)
        .where('version', '=', input.expectedVersion)
        .returning('owner_id')
        .executeTakeFirst();
      if (!changed) throw new SettingsConflictError('Settings were changed by another request');
    }
    return this.get(ownerId);
  }
}

function defaultView(): InstallationSettingsView {
  return assemble(defaults, defaults, 0, null);
}

function view(row: Selectable<InstallationSettingsTable>): InstallationSettingsView {
  return assemble(
    {
      uploadMaxBytes: Number(row.upload_max_bytes),
      archiveMaxMembers: row.archive_max_members,
      archiveExpandedMaxBytes: Number(row.archive_expanded_max_bytes),
      archiveMaxRatio: row.archive_max_ratio,
    },
    {
      trashDays: row.trash_retention_days,
      jobDays: row.job_retention_days,
      observationHistoryEntries: row.observation_history_entries,
    },
    row.version,
    row.updated_at,
  );
}

function assemble(
  limits: InstallationSettingsView['limits'],
  retention: InstallationSettingsView['retention'],
  version: number,
  updatedAt: Date | null,
): InstallationSettingsView {
  return {
    limits,
    retention,
    authentication: { mode: 'password' },
    notifications: {
      mode: 'webhook',
      configurable: true,
      apiPath: '/api/v1/notifications/webhook-configuration',
      message: 'Generic HTTPS webhook delivery is available.',
    },
    configurationSurfaces: {
      printers: { apiPath: '/api/v1/printing/printers' },
      storage: { managedByInstallation: true, exposesSecrets: false },
    },
    version,
    updatedAt,
  };
}

function validateLimits(value: InstallationSettingsView['limits']) {
  bounded(value.uploadMaxBytes, 1_048_576, 53_687_091_200, 'uploadMaxBytes');
  bounded(value.archiveMaxMembers, 1, 100_000, 'archiveMaxMembers');
  bounded(value.archiveExpandedMaxBytes, 1_048_576, 107_374_182_400, 'archiveExpandedMaxBytes');
  bounded(value.archiveMaxRatio, 1, 10_000, 'archiveMaxRatio');
  return value;
}

function validateRetention(value: InstallationSettingsView['retention']) {
  bounded(value.trashDays, 1, 3_650, 'trashDays');
  bounded(value.jobDays, 1, 3_650, 'jobDays');
  bounded(value.observationHistoryEntries, 10, 10_000, 'observationHistoryEntries');
  return value;
}

function bounded(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`${name} is outside its supported range`);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
