import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';

import type { OwnerContext } from '../../identity/index.js';
import { HttpError } from '../../platform/http/index.js';
import type {
  CatalogueAssetFormat,
  CatalogueDatabaseSchema,
  CatalogueImportSource,
} from '../schema.js';
import {
  CatalogueSearchRequestError,
  CatalogueSearchService,
  type CatalogueSearchSort,
  catalogueSearchSorts,
} from './service.js';

export interface CatalogueSearchIdentityBoundary {
  readonly requireOwner: (request: FastifyRequest) => Promise<void>;
  readonly ownerForRequest: (request: FastifyRequest) => OwnerContext;
}

export interface CatalogueSearchFeatureOptions {
  readonly database: Kysely<CatalogueDatabaseSchema>;
  readonly identity: CatalogueSearchIdentityBoundary;
}

export function registerCatalogueSearchFeature(
  application: FastifyInstance,
  options: CatalogueSearchFeatureOptions,
): CatalogueSearchService {
  const service = new CatalogueSearchService(options.database);
  application.get(
    '/api/v1/catalogue/models',
    { preHandler: options.identity.requireOwner },
    async (request) => {
      try {
        const query = requestQuery(request);
        return await service.search(options.identity.ownerForRequest(request).owner.id, {
          ...(query.q === undefined ? {} : { query: query.q }),
          ...(query.tagId === undefined ? {} : { tagId: query.tagId }),
          ...(query.collectionId === undefined ? {} : { collectionId: query.collectionId }),
          ...(query.favorite === undefined
            ? {}
            : { favorite: booleanValue(query.favorite, 'favorite') }),
          ...(query.format === undefined ? {} : { assetFormat: assetFormat(query.format) }),
          ...(query.source === undefined ? {} : { importSource: importSource(query.source) }),
          ...(query.printed === undefined
            ? {}
            : { printed: booleanValue(query.printed, 'printed') }),
          ...(query.sort === undefined ? {} : { sort: sortValue(query.sort) }),
          ...(query.direction === undefined ? {} : { direction: directionValue(query.direction) }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.limit === undefined ? {} : { limit: numberValue(query.limit, 'limit') }),
        });
      } catch (error) {
        if (error instanceof CatalogueSearchRequestError)
          throw new HttpError(400, 'catalogue_search_invalid', error.message);
        throw error;
      }
    },
  );
  return service;
}

function requestQuery(request: FastifyRequest): Record<string, string | undefined> {
  if (typeof request.query !== 'object' || request.query === null || Array.isArray(request.query))
    return {};
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.query)) {
    if (value !== undefined && typeof value !== 'string')
      throw new CatalogueSearchRequestError(`${key} must occur once`);
    result[key] = value as string | undefined;
  }
  return result;
}

function booleanValue(value: string, field: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new CatalogueSearchRequestError(`${field} must be true or false`);
}

function numberValue(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new CatalogueSearchRequestError(`${field} must be an integer`);
  return parsed;
}

function assetFormat(value: string): CatalogueAssetFormat {
  const formats: readonly string[] = [
    'stl',
    '3mf',
    'obj',
    'step',
    'gcode',
    'image',
    'document',
    'archive',
    'other',
  ];
  if (!formats.includes(value)) throw new CatalogueSearchRequestError('format is invalid');
  return value as CatalogueAssetFormat;
}

function importSource(value: string): CatalogueImportSource {
  if (value !== 'upload' && value !== 'yuki_export')
    throw new CatalogueSearchRequestError('source is invalid');
  return value;
}

function sortValue(value: string): CatalogueSearchSort {
  if (!catalogueSearchSorts.includes(value as CatalogueSearchSort))
    throw new CatalogueSearchRequestError('sort is invalid');
  return value as CatalogueSearchSort;
}

function directionValue(value: string): 'asc' | 'desc' {
  if (value !== 'asc' && value !== 'desc')
    throw new CatalogueSearchRequestError('direction is invalid');
  return value;
}
