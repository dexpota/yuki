import { Buffer } from 'node:buffer';

import { type Kysely, type RawBuilder, sql } from 'kysely';

import type {
  CatalogueAssetFormat,
  CatalogueDatabaseSchema,
  CatalogueImportSource,
} from '../schema.js';

export const catalogueSearchSorts = [
  'name',
  'importedAt',
  'updatedAt',
  'lastPrintedAt',
  'printCount',
] as const;
export type CatalogueSearchSort = (typeof catalogueSearchSorts)[number];
export type CatalogueSearchDirection = 'asc' | 'desc';

export interface CatalogueSearchInput {
  readonly query?: string;
  readonly tagId?: string;
  readonly collectionId?: string;
  readonly favorite?: boolean;
  readonly assetFormat?: CatalogueAssetFormat;
  readonly importSource?: CatalogueImportSource;
  readonly printed?: boolean;
  readonly sort?: CatalogueSearchSort;
  readonly direction?: CatalogueSearchDirection;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CatalogueSearchItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly creator: string | null;
  readonly sourceUrl: string | null;
  readonly importSource: CatalogueImportSource;
  readonly favorite: boolean;
  readonly currentVersionId: string;
  readonly coverAssetId: string | null;
  readonly printCount: number;
  readonly lastPrintedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CatalogueSearchPage {
  readonly items: readonly CatalogueSearchItem[];
  readonly nextCursor: string | null;
}

interface SearchRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly creator: string | null;
  readonly source_url: string | null;
  readonly import_source: CatalogueImportSource;
  readonly favorite: boolean;
  readonly current_version_id: string;
  readonly cover_asset_id: string | null;
  readonly print_count: number;
  readonly last_printed_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CursorPayload {
  readonly v: 1;
  readonly sort: CatalogueSearchSort;
  readonly direction: CatalogueSearchDirection;
  readonly value: string | number | null;
  readonly id: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CatalogueSearchRequestError extends TypeError {
  override readonly name = 'CatalogueSearchRequestError';
}

export class CatalogueSearchService {
  constructor(private readonly database: Kysely<CatalogueDatabaseSchema>) {}

  async search(ownerId: string, input: CatalogueSearchInput = {}): Promise<CatalogueSearchPage> {
    requireUuid(ownerId, 'ownerId');
    const sort = input.sort ?? 'updatedAt';
    const direction = input.direction ?? defaultDirection(sort);
    const limit = input.limit ?? 50;
    if (!catalogueSearchSorts.includes(sort)) invalid('sort is invalid');
    if (direction !== 'asc' && direction !== 'desc') invalid('direction is invalid');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      invalid('limit must be an integer between 1 and 100');

    const filters: RawBuilder<unknown>[] = [sql`m.owner_id = ${ownerId}`];
    const query = input.query?.trim();
    if (query) {
      const searchTerms = query.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (searchTerms) {
        filters.push(sql`m.id in (
          select sm.id
          from catalogue_models sm
          where sm.owner_id = ${ownerId}
            and sm.search_document @@ plainto_tsquery('simple', ${searchTerms})
          union
          select mt.model_id
          from catalogue_model_tags mt
          join catalogue_tags t on t.id = mt.tag_id and t.owner_id = mt.owner_id
          where mt.owner_id = ${ownerId}
            and to_tsvector(
              'simple', regexp_replace(t.name, '[^[:alnum:]]+', ' ', 'g')
            ) @@ plainto_tsquery('simple', ${searchTerms})
          union
          select a.model_id
          from catalogue_assets a
          join catalogue_models am on am.id = a.model_id
          where am.owner_id = ${ownerId}
            and to_tsvector(
              'simple', regexp_replace(a.original_filename, '[^[:alnum:]]+', ' ', 'g')
            ) @@ plainto_tsquery('simple', ${searchTerms})
        )`);
      }
    }
    if (input.tagId !== undefined) {
      requireUuid(input.tagId, 'tagId');
      filters.push(sql`exists (
        select 1 from catalogue_model_tags mt
        where mt.model_id = m.id and mt.owner_id = ${ownerId} and mt.tag_id = ${input.tagId}
      )`);
    }
    if (input.collectionId !== undefined) {
      requireUuid(input.collectionId, 'collectionId');
      filters.push(sql`exists (
        select 1 from catalogue_model_collections mc
        where mc.model_id = m.id
          and mc.owner_id = ${ownerId}
          and mc.collection_id = ${input.collectionId}
      )`);
    }
    if (input.favorite !== undefined) filters.push(sql`m.favorite = ${input.favorite}`);
    if (input.assetFormat !== undefined) {
      filters.push(sql`exists (
        select 1 from catalogue_assets a
        where a.model_id = m.id and a.format = ${input.assetFormat}
      )`);
    }
    if (input.importSource !== undefined)
      filters.push(sql`m.import_source = ${input.importSource}`);
    if (input.printed !== undefined)
      filters.push(input.printed ? sql`m.print_count > 0` : sql`m.print_count = 0`);

    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor, sort, direction);
      filters.push(cursorPredicate(sort, direction, cursor));
    }

    const order = sortExpression(sort);
    const result = await sql<SearchRow>`
      select
        m.id, m.name, m.description, m.creator, m.source_url, m.import_source,
        m.favorite, m.current_version_id, m.cover_asset_id, m.print_count,
        m.last_printed_at, m.created_at, m.updated_at
      from catalogue_models m
      where ${sql.join(filters, sql` and `)}
      order by ${order} ${sql.raw(direction)} nulls last, m.id asc
      limit ${limit + 1}
    `.execute(this.database);

    const hasMore = result.rows.length > limit;
    const pageRows = result.rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toItem),
      nextCursor: hasMore && last ? encodeCursor(last, sort, direction) : null,
    };
  }
}

function cursorPredicate(
  sort: CatalogueSearchSort,
  direction: CatalogueSearchDirection,
  cursor: CursorPayload,
): RawBuilder<unknown> {
  const expression = sortExpression(sort);
  if (cursor.value === null) return sql`${expression} is null and m.id > ${cursor.id}`;
  const comparison = sql.raw(direction === 'asc' ? '>' : '<');
  return sql`(
    ${expression} ${comparison} ${cursor.value}
    or (${expression} = ${cursor.value} and m.id > ${cursor.id})
    or ${expression} is null
  )`;
}

function sortExpression(sort: CatalogueSearchSort): RawBuilder<unknown> {
  switch (sort) {
    case 'name':
      return sql`lower(m.name)`;
    case 'importedAt':
      return sql`m.created_at`;
    case 'updatedAt':
      return sql`m.updated_at`;
    case 'lastPrintedAt':
      return sql`m.last_printed_at`;
    case 'printCount':
      return sql`m.print_count`;
  }
}

function encodeCursor(
  row: SearchRow,
  sort: CatalogueSearchSort,
  direction: CatalogueSearchDirection,
): string {
  const payload: CursorPayload = {
    v: 1,
    sort,
    direction,
    value: cursorValue(row, sort),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(
  encoded: string,
  sort: CatalogueSearchSort,
  direction: CatalogueSearchDirection,
): CursorPayload {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (
      !isRecord(parsed) ||
      parsed.v !== 1 ||
      parsed.sort !== sort ||
      parsed.direction !== direction
    )
      invalid('cursor does not match the requested sort');
    if (typeof parsed.id !== 'string' || !uuidPattern.test(parsed.id)) invalid('cursor is invalid');
    if (!validCursorValue(sort, parsed.value)) invalid('cursor is invalid');
    return parsed as unknown as CursorPayload;
  } catch (error) {
    if (error instanceof CatalogueSearchRequestError) throw error;
    invalid('cursor is invalid');
  }
}

function cursorValue(row: SearchRow, sort: CatalogueSearchSort): string | number | null {
  switch (sort) {
    case 'name':
      return row.name.toLowerCase();
    case 'importedAt':
      return row.created_at.toISOString();
    case 'updatedAt':
      return row.updated_at.toISOString();
    case 'lastPrintedAt':
      return row.last_printed_at?.toISOString() ?? null;
    case 'printCount':
      return row.print_count;
  }
}

function validCursorValue(sort: CatalogueSearchSort, value: unknown): boolean {
  if (sort === 'lastPrintedAt' && value === null) return true;
  if (sort === 'printCount') return typeof value === 'number' && Number.isSafeInteger(value);
  if (typeof value !== 'string') return false;
  if (sort === 'name') return value.length > 0 && value.length <= 300;
  return Number.isFinite(Date.parse(value));
}

function toItem(row: SearchRow): CatalogueSearchItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    creator: row.creator,
    sourceUrl: row.source_url,
    importSource: row.import_source,
    favorite: row.favorite,
    currentVersionId: row.current_version_id,
    coverAssetId: row.cover_asset_id,
    printCount: row.print_count,
    lastPrintedAt: row.last_printed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function defaultDirection(sort: CatalogueSearchSort): CatalogueSearchDirection {
  return sort === 'name' ? 'asc' : 'desc';
}

function requireUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) invalid(`${field} must be a UUID`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new CatalogueSearchRequestError(message);
}
