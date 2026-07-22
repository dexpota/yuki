import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';

import type { OwnerContext } from '../identity/index.js';
import { HttpError } from '../platform/http/index.js';
import type { SettingsDatabaseSchema } from './schema.js';
import {
  InstallationSettingsService,
  SettingsConflictError,
  type UpdateInstallationSettings,
} from './service.js';

export interface SettingsIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export interface SettingsFeatureOptions {
  readonly database: Kysely<SettingsDatabaseSchema>;
  readonly identity: SettingsIdentityBoundary;
  readonly service?: InstallationSettingsService;
}

export interface SettingsFeature {
  readonly service: InstallationSettingsService;
}

export function registerSettingsFeature(
  application: FastifyInstance,
  options: SettingsFeatureOptions,
): SettingsFeature {
  const service = options.service ?? new InstallationSettingsService(options.database);
  const authenticated = { preHandler: options.identity.requireOwner };
  const ownerId = (request: FastifyRequest) => options.identity.ownerForRequest(request).owner.id;
  application.get('/api/v1/settings/installation', authenticated, (request) =>
    service.get(ownerId(request)),
  );
  application.patch('/api/v1/settings/installation', authenticated, async (request) => {
    try {
      return await service.update(ownerId(request), updateBody(request.body));
    } catch (error) {
      if (error instanceof SettingsConflictError)
        throw new HttpError(409, 'settings_conflict', error.message);
      if (error instanceof TypeError || error instanceof RangeError)
        throw new HttpError(400, 'settings_invalid', error.message);
      throw error;
    }
  });
  return { service };
}

function updateBody(value: unknown): UpdateInstallationSettings {
  if (!isObject(value)) throw new TypeError('Settings body is required');
  exactKeys(value, ['limits', 'retention', 'authenticationMode', 'expectedVersion']);
  if (!Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 0)
    throw new TypeError('expectedVersion is invalid');
  return {
    expectedVersion: Number(value.expectedVersion),
    ...(value.limits === undefined ? {} : { limits: limits(value.limits) }),
    ...(value.retention === undefined ? {} : { retention: retention(value.retention) }),
    ...(value.authenticationMode === undefined
      ? {}
      : { authenticationMode: authentication(value.authenticationMode) }),
  };
}

function limits(value: unknown): NonNullable<UpdateInstallationSettings['limits']> {
  if (!isObject(value)) throw new TypeError('limits is invalid');
  exactKeys(value, [
    'uploadMaxBytes',
    'archiveMaxMembers',
    'archiveExpandedMaxBytes',
    'archiveMaxRatio',
  ]);
  return {
    uploadMaxBytes: integer(value.uploadMaxBytes, 'uploadMaxBytes'),
    archiveMaxMembers: integer(value.archiveMaxMembers, 'archiveMaxMembers'),
    archiveExpandedMaxBytes: integer(value.archiveExpandedMaxBytes, 'archiveExpandedMaxBytes'),
    archiveMaxRatio: integer(value.archiveMaxRatio, 'archiveMaxRatio'),
  };
}

function retention(value: unknown): NonNullable<UpdateInstallationSettings['retention']> {
  if (!isObject(value)) throw new TypeError('retention is invalid');
  exactKeys(value, ['trashDays', 'jobDays', 'observationHistoryEntries']);
  return {
    trashDays: integer(value.trashDays, 'trashDays'),
    jobDays: integer(value.jobDays, 'jobDays'),
    observationHistoryEntries: integer(
      value.observationHistoryEntries,
      'observationHistoryEntries',
    ),
  };
}

function authentication(value: unknown): 'password' {
  if (value !== 'password') throw new TypeError('authenticationMode is unsupported');
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} is invalid`);
  return Number(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new TypeError('Settings body contains unsupported fields');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
