import { randomUUID } from 'node:crypto';

import type { Kysely, Selectable } from 'kysely';

import {
  type FilamentPresetFields,
  type FilamentPresetInput,
  normalizeFilamentPreset,
} from './preset.js';
import type { FilamentPresetDatabaseSchema, FilamentPresetTable } from './schema.js';

export class FilamentPresetNotFoundError extends Error {
  override readonly name = 'FilamentPresetNotFoundError';
}

export class FilamentPresetConflictError extends Error {
  override readonly name = 'FilamentPresetConflictError';
}

export interface UpdateFilamentPresetInput {
  readonly displayName?: string;
  readonly material?: string;
  readonly colorName?: string | null;
  readonly colorHex?: string | null;
  readonly manufacturer?: string | null;
  readonly productName?: string | null;
  readonly diameterMm?: number | null;
  readonly notes?: string;
  readonly expectedVersion: number;
}

export interface FilamentPresetView extends FilamentPresetFields {
  readonly id: string;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface FilamentPresetServiceOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export class FilamentPresetService {
  readonly #now: () => Date;
  readonly #newId: () => string;

  public constructor(
    private readonly database: Kysely<FilamentPresetDatabaseSchema>,
    options: FilamentPresetServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
  }

  public async create(ownerId: string, input: FilamentPresetInput): Promise<FilamentPresetView> {
    const fields = normalizeFilamentPreset(input);
    const id = this.#newId();
    const now = this.#now();
    await this.database
      .insertInto('filament_presets')
      .values({
        id,
        owner_id: ownerId,
        ...databaseFields(fields),
        archived_at: null,
        created_at: now,
        updated_at: now,
        version: 1,
      })
      .executeTakeFirstOrThrow();
    return this.get(ownerId, id);
  }

  public async list(
    ownerId: string,
    options: { readonly includeArchived?: boolean } = {},
  ): Promise<readonly FilamentPresetView[]> {
    let query = this.database
      .selectFrom('filament_presets')
      .selectAll()
      .where('owner_id', '=', ownerId);
    if (!options.includeArchived) query = query.where('archived_at', 'is', null);
    return (
      await query
        .orderBy('archived_at', 'asc')
        .orderBy('display_name', 'asc')
        .orderBy('id', 'asc')
        .execute()
    ).map(view);
  }

  public async get(ownerId: string, presetId: string): Promise<FilamentPresetView> {
    const row = await this.ownedRow(ownerId, presetId);
    return view(row);
  }

  public async update(
    ownerId: string,
    presetId: string,
    input: UpdateFilamentPresetInput,
  ): Promise<FilamentPresetView> {
    validExpectedVersion(input.expectedVersion);
    const changedFields = Object.keys(input).filter((key) => key !== 'expectedVersion');
    if (changedFields.length === 0) throw new TypeError('At least one filament field is required');
    const current = await this.ownedRow(ownerId, presetId);
    const fields = normalizeFilamentPreset({
      displayName: input.displayName ?? current.display_name,
      material: input.material ?? current.material,
      colorName: input.colorName === undefined ? current.color_name : input.colorName,
      colorHex: input.colorHex === undefined ? current.color_hex : input.colorHex,
      manufacturer: input.manufacturer === undefined ? current.manufacturer : input.manufacturer,
      productName: input.productName === undefined ? current.product_name : input.productName,
      diameterMm:
        input.diameterMm === undefined ? numberOrNull(current.diameter_mm) : input.diameterMm,
      notes: input.notes ?? current.notes,
    });
    const updated = await this.database
      .updateTable('filament_presets')
      .set({
        ...databaseFields(fields),
        updated_at: this.#now(),
        version: current.version + 1,
      })
      .where('id', '=', presetId)
      .where('owner_id', '=', ownerId)
      .where('version', '=', input.expectedVersion)
      .returning('id')
      .executeTakeFirst();
    if (!updated)
      throw new FilamentPresetConflictError('Filament preset was changed by another request');
    return this.get(ownerId, presetId);
  }

  public async archive(
    ownerId: string,
    presetId: string,
    expectedVersion: number,
  ): Promise<FilamentPresetView> {
    validExpectedVersion(expectedVersion);
    const current = await this.ownedRow(ownerId, presetId);
    if (current.archived_at !== null)
      throw new FilamentPresetConflictError('Filament preset is already archived');
    return this.setArchived(ownerId, presetId, expectedVersion, current.version, this.#now());
  }

  public async restore(
    ownerId: string,
    presetId: string,
    expectedVersion: number,
  ): Promise<FilamentPresetView> {
    validExpectedVersion(expectedVersion);
    const current = await this.ownedRow(ownerId, presetId);
    if (current.archived_at === null)
      throw new FilamentPresetConflictError('Filament preset is not archived');
    return this.setArchived(ownerId, presetId, expectedVersion, current.version, null);
  }

  private async setArchived(
    ownerId: string,
    presetId: string,
    expectedVersion: number,
    currentVersion: number,
    archivedAt: Date | null,
  ): Promise<FilamentPresetView> {
    const updated = await this.database
      .updateTable('filament_presets')
      .set({
        archived_at: archivedAt,
        updated_at: this.#now(),
        version: currentVersion + 1,
      })
      .where('id', '=', presetId)
      .where('owner_id', '=', ownerId)
      .where('version', '=', expectedVersion)
      .returning('id')
      .executeTakeFirst();
    if (!updated)
      throw new FilamentPresetConflictError('Filament preset was changed by another request');
    return this.get(ownerId, presetId);
  }

  private async ownedRow(
    ownerId: string,
    presetId: string,
  ): Promise<Selectable<FilamentPresetTable>> {
    const row = await this.database
      .selectFrom('filament_presets')
      .selectAll()
      .where('id', '=', presetId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!row) throw new FilamentPresetNotFoundError('Filament preset not found');
    return row;
  }
}

function databaseFields(fields: FilamentPresetFields) {
  return {
    display_name: fields.displayName,
    material: fields.material,
    color_name: fields.colorName,
    color_hex: fields.colorHex,
    manufacturer: fields.manufacturer,
    product_name: fields.productName,
    diameter_mm: fields.diameterMm,
    notes: fields.notes,
  };
}

function view(row: Selectable<FilamentPresetTable>): FilamentPresetView {
  return {
    id: row.id,
    displayName: row.display_name,
    material: row.material,
    colorName: row.color_name,
    colorHex: row.color_hex,
    manufacturer: row.manufacturer,
    productName: row.product_name,
    diameterMm: numberOrNull(row.diameter_mm),
    notes: row.notes,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new TypeError('Stored filament diameter is invalid');
  return result;
}

function validExpectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError('expectedVersion must be a positive integer');
}
