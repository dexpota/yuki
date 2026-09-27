import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import {
  type AssetFormat,
  type Collection,
  type CatalogueItem,
  type CatalogueSearch,
  type CatalogueSort,
  type Tag,
  listCollections,
  listTags,
  searchCatalogue,
} from '../api.js';
import '../catalogue.css';

const initialSearch: CatalogueSearch = { sort: 'updatedAt', direction: 'desc' };
const catalogueSorts: readonly CatalogueSort[] = [
  'updatedAt',
  'importedAt',
  'name',
  'lastPrintedAt',
  'printCount',
];
const assetFormats: readonly AssetFormat[] = [
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

export function CataloguePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const locationFilters = searchParams.toString();
  const initialFromLocation = readLocationFilters(searchParams);
  const [draft, setDraft] = useState<CatalogueSearch>(initialFromLocation);
  const search = initialFromLocation;
  const [filtersOpen, setFiltersOpen] = useState(hasPanelFilters(initialFromLocation));
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(hasMoreFilters(initialFromLocation));
  const catalogue = useInfiniteQuery({
    queryKey: ['catalogue', 'browse', search],
    queryFn: ({ pageParam }) => searchCatalogue(search, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const tags = useQuery({ queryKey: ['catalogue', 'tags'], queryFn: listTags });
  const collections = useQuery({
    queryKey: ['catalogue', 'collections'],
    queryFn: listCollections,
  });

  const items = catalogue.data?.pages.flatMap((page) => page.items) ?? [];
  useEffect(() => {
    const next = readLocationFilters(new URLSearchParams(locationFilters));
    setDraft(next);
    if (hasPanelFilters(next)) setFiltersOpen(true);
    if (hasMoreFilters(next)) setMoreFiltersOpen(true);
  }, [locationFilters]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSearchParams(writeLocationFilters(draft));
  };
  const activeFilters = filterChips(search, tags.data ?? [], collections.data ?? []);
  const removeFilter = (key: FilterKey) => {
    const next = { ...search, [key]: undefined };
    setDraft(next);
    setSearchParams(writeLocationFilters(next));
  };

  return (
    <section className={`catalogue-page${activeFilters.length > 0 ? ' has-active-filters' : ''}`}>
      <header className="catalogue-heading">
        <div>
          <h1>Your models</h1>
          <p className="catalogue-intro">
            Browse, organize, and keep your 3D models together in one place.
          </p>
        </div>
        <Link className="catalogue-import-link" to="/import">
          Import model
        </Link>
      </header>

      <form className="catalogue-tools" onSubmit={submit} aria-label="Catalogue search and filters">
        <div className="catalogue-search-row">
          <div className="catalogue-search-group">
            <label className="catalogue-search">
              <span className="visually-hidden">Search catalogue</span>
              <input
                type="search"
                value={draft.query ?? ''}
                placeholder="Search models, creators, tags…"
                onChange={(event) => setDraft({ ...draft, query: event.target.value })}
              />
            </label>
            <button className="catalogue-search-submit" type="submit">
              Search
            </button>
          </div>
          <button
            className="filter-toggle secondary-button"
            type="button"
            aria-expanded={filtersOpen}
            aria-controls="catalogue-filter-panel"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <span className="filter-symbol" aria-hidden="true" />
            Filters
            {hasFilters(search) ? <span className="active-filter-dot" aria-hidden="true" /> : null}
          </button>
          <label className="catalogue-sort">
            <span>Sort</span>
            <select
              value={draft.sort}
              onChange={(event) => {
                const next = { ...draft, sort: event.target.value as CatalogueSort };
                setDraft(next);
                setSearchParams(writeLocationFilters(next));
              }}
            >
              {[
                ['updatedAt', 'Recently updated'],
                ['importedAt', 'Import date'],
                ['name', 'Name'],
                ['lastPrintedAt', 'Last printed'],
                ['printCount', 'Print count'],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {filtersOpen ? (
          <div className="catalogue-filter-panel" id="catalogue-filter-panel">
            <div className="catalogue-filter-primary">
              <SelectFilter
                label="Favorite"
                value={booleanValue(draft.favorite)}
                onChange={(value) => setDraft({ ...draft, favorite: optionalBoolean(value) })}
                options={[
                  ['', 'All models'],
                  ['true', 'Favorites'],
                  ['false', 'Not favorites'],
                ]}
              />
              <SelectFilter
                label="File format"
                value={draft.format ?? ''}
                onChange={(value) =>
                  setDraft({ ...draft, format: (value || undefined) as AssetFormat | undefined })
                }
                options={[
                  ['', 'Any format'],
                  ...assetFormats.map(
                    (format) => [format, format.toUpperCase()] as [string, string],
                  ),
                ]}
              />
              <SelectFilter
                label="Print history"
                value={booleanValue(draft.printed)}
                onChange={(value) => setDraft({ ...draft, printed: optionalBoolean(value) })}
                options={[
                  ['', 'Any history'],
                  ['true', 'Printed'],
                  ['false', 'Never printed'],
                ]}
              />
              <button
                className="secondary-button more-filters-toggle"
                type="button"
                aria-expanded={moreFiltersOpen}
                onClick={() => setMoreFiltersOpen((open) => !open)}
              >
                {moreFiltersOpen ? 'Fewer options' : 'More options'}
              </button>
            </div>
            {moreFiltersOpen ? (
              <>
                <div className="catalogue-filter-more">
                  <SelectFilter
                    label="Tag"
                    value={draft.tagId ?? ''}
                    onChange={(value) => setDraft({ ...draft, tagId: value || undefined })}
                    options={[
                      ['', tags.isError ? 'Tags unavailable' : 'Any tag'],
                      ...(tags.data ?? []).map((tag) => [tag.id, tag.name] as [string, string]),
                    ]}
                  />
                  <SelectFilter
                    label="Collection"
                    value={draft.collectionId ?? ''}
                    onChange={(value) => setDraft({ ...draft, collectionId: value || undefined })}
                    options={[
                      ['', collections.isError ? 'Collections unavailable' : 'Any collection'],
                      ...(collections.data ?? []).map(
                        (collection) => [collection.id, collection.name] as [string, string],
                      ),
                    ]}
                  />
                  <SelectFilter
                    label="Source"
                    value={draft.source ?? ''}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        source: (value || undefined) as CatalogueSearch['source'],
                      })
                    }
                    options={[
                      ['', 'Any source'],
                      ['upload', 'Upload'],
                      ['yuki_export', 'Yuki export'],
                    ]}
                  />
                  <SelectFilter
                    label="Direction"
                    value={draft.direction}
                    onChange={(value) =>
                      setDraft({ ...draft, direction: value as CatalogueSearch['direction'] })
                    }
                    options={[
                      ['desc', 'Descending'],
                      ['asc', 'Ascending'],
                    ]}
                  />
                </div>
                {tags.isError || collections.isError ? (
                  <div className="catalogue-filter-data-error" role="alert">
                    {tags.isError ? (
                      <span>
                        Tags could not load.{' '}
                        <button type="button" onClick={() => void tags.refetch()}>
                          Retry tags
                        </button>
                      </span>
                    ) : null}
                    {collections.isError ? (
                      <span>
                        Collections could not load.{' '}
                        <button type="button" onClick={() => void collections.refetch()}>
                          Retry collections
                        </button>
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
            <div className="catalogue-filter-actions">
              <button type="submit">Apply filters</button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setDraft(initialSearch);
                  setSearchParams(new URLSearchParams());
                }}
              >
                Clear all
              </button>
            </div>
          </div>
        ) : null}
      </form>

      {activeFilters.length > 0 ? (
        <fieldset className="active-filter-chips">
          <legend className="visually-hidden">Active filters</legend>
          {activeFilters.map(({ key, label }) => (
            <button
              className="filter-chip"
              key={key}
              type="button"
              aria-label={`Remove ${label} filter`}
              onClick={() => removeFilter(key)}
            >
              <span>{label}</span>
              <span className="filter-chip-remove" aria-hidden="true" />
            </button>
          ))}
          <button
            className="clear-filters-link"
            type="button"
            onClick={() => {
              setDraft(initialSearch);
              setSearchParams(new URLSearchParams());
            }}
          >
            Clear all
          </button>
        </fieldset>
      ) : null}

      {catalogue.isPending ? <Status message="Loading your catalogue…" busy /> : null}
      {catalogue.isError ? (
        <Status
          message="The catalogue could not be loaded."
          action={() => void catalogue.refetch()}
        />
      ) : null}
      {catalogue.isSuccess && items.length === 0 ? (
        <div className="catalogue-empty" role="status">
          <h2>
            {hasFilters(search) ? 'No models match these filters.' : 'Your catalogue is empty.'}
          </h2>
          <p>
            {hasFilters(search)
              ? 'Clear a filter or adjust your search to see more models.'
              : 'Import model files or a ZIP archive to start your catalogue.'}
          </p>
          {hasFilters(search) ? (
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setDraft(initialSearch);
                setSearchParams(new URLSearchParams());
              }}
            >
              Clear filters
            </button>
          ) : (
            <Link className="catalogue-import-link" to="/import">
              Import a model
            </Link>
          )}
        </div>
      ) : null}
      {items.length > 0 ? (
        <ul className="catalogue-grid" aria-label="Models">
          {items.map((model) => (
            <li key={model.id}>
              <Link className="model-card" to={`/catalogue/models/${model.id}`}>
                <div className="model-card-media">
                  {model.thumbnail.status === 'ready' && model.thumbnail.downloadUrl ? (
                    <img
                      src={model.thumbnail.downloadUrl}
                      alt={`${model.name} thumbnail`}
                      loading="lazy"
                      decoding="async"
                      width="320"
                      height="240"
                    />
                  ) : (
                    <span
                      className="model-card-thumbnail-fallback"
                      role="img"
                      aria-label={thumbnailFallback(model.thumbnail.status)}
                    >
                      <svg viewBox="0 0 40 40" aria-hidden="true">
                        <path d="m20 4 14 8v16l-14 8-14-8V12l14-8Z" />
                        <path d="m6 12 14 8 14-8M20 20v16" />
                      </svg>
                      {thumbnailVisibleStatus(model.thumbnail.status) ? (
                        <span className="model-card-thumbnail-status" aria-hidden="true">
                          {thumbnailVisibleStatus(model.thumbnail.status)}
                        </span>
                      ) : null}
                    </span>
                  )}
                </div>
                <div className="model-card-info">
                  <div className="model-card-heading">
                    <strong title={model.name}>{model.name}</strong>
                    {model.favorite ? (
                      <span className="model-card-favorite" role="img" aria-label="Favorite">
                        <svg viewBox="0 0 20 20" aria-hidden="true">
                          <path d="m10 2.3 2.35 4.76 5.25.76-3.8 3.7.9 5.23L10 14.28l-4.7 2.47.9-5.23-3.8-3.7 5.25-.76L10 2.3Z" />
                        </svg>
                      </span>
                    ) : null}
                  </div>
                  {model.description ? (
                    <p className="model-card-description">{model.description}</p>
                  ) : null}
                  {model.creator ? (
                    <span className="model-card-creator">{model.creator}</span>
                  ) : null}
                  {model.fileSummary ? (
                    <div className="model-card-file" title={model.fileSummary.filename}>
                      <span className="model-card-format">
                        {model.fileSummary.format.toUpperCase()}
                      </span>
                      <span className="model-card-filename">{model.fileSummary.filename}</span>
                      {model.fileSummary.count > 1 ? (
                        <span className="model-card-file-extra">
                          {model.fileSummary.count} files
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <span className="model-card-file-unavailable">File details unavailable</span>
                  )}
                  <div className="model-card-meta">
                    <span>{model.currentVersionLabel}</span>
                    {model.printCount > 0 ? (
                      <span>
                        {model.printCount} {model.printCount === 1 ? 'print' : 'prints'}
                      </span>
                    ) : null}
                  </div>
                  {model.lastPrintedAt ? (
                    <small className="model-card-last-printed">
                      Last printed {formatDate(model.lastPrintedAt)}
                    </small>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {catalogue.hasNextPage ? (
        <button
          className="load-more"
          type="button"
          disabled={catalogue.isFetchingNextPage}
          onClick={() => void catalogue.fetchNextPage()}
        >
          {catalogue.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </section>
  );
}

function SelectFilter({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly (readonly [string, string])[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, name]) => (
          <option key={optionValue} value={optionValue}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Status({
  message,
  busy = false,
  action,
}: {
  readonly message: string;
  readonly busy?: boolean;
  readonly action?: () => void;
}) {
  return (
    <div className="catalogue-status" aria-busy={busy} role={action ? 'alert' : 'status'}>
      <p>{message}</p>
      {action ? (
        <button type="button" onClick={action}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

function booleanValue(value: boolean | undefined): string {
  return value === undefined ? '' : String(value);
}

function optionalBoolean(value: string): boolean | undefined {
  return value === '' ? undefined : value === 'true';
}

function thumbnailFallback(status: CatalogueItem['thumbnail']['status']): string {
  if (status === 'queued' || status === 'processing') return 'Thumbnail is being generated';
  if (status === 'failed') return 'Thumbnail generation failed';
  if (status === 'unsupported') return 'Thumbnail is unsupported';
  return 'Thumbnail unavailable';
}

function thumbnailVisibleStatus(status: CatalogueItem['thumbnail']['status']): string | null {
  if (status === 'queued' || status === 'processing') return 'Generating preview';
  if (status === 'failed') return 'Preview failed';
  if (status === 'unsupported') return 'Preview unavailable';
  return null;
}

function readLocationFilters(params: URLSearchParams): CatalogueSearch {
  return {
    ...initialSearch,
    query: params.get('q') || undefined,
    collectionId: params.get('collectionId') || undefined,
    tagId: params.get('tagId') || undefined,
    favorite: readBooleanParam(params.get('favorite')),
    format: readEnumParam(params.get('format'), assetFormats),
    source: readEnumParam(params.get('source'), ['upload', 'yuki_export'] as const),
    printed: readBooleanParam(params.get('printed')),
    sort: readEnumParam(params.get('sort'), catalogueSorts) ?? initialSearch.sort,
    direction:
      readEnumParam(params.get('direction'), ['asc', 'desc'] as const) ?? initialSearch.direction,
  };
}

function writeLocationFilters(search: CatalogueSearch): URLSearchParams {
  const params = new URLSearchParams();
  if (search.query?.trim()) params.set('q', search.query.trim());
  if (search.collectionId) params.set('collectionId', search.collectionId);
  if (search.tagId) params.set('tagId', search.tagId);
  if (search.favorite !== undefined) params.set('favorite', String(search.favorite));
  if (search.format) params.set('format', search.format);
  if (search.source) params.set('source', search.source);
  if (search.printed !== undefined) params.set('printed', String(search.printed));
  if (search.sort !== initialSearch.sort) params.set('sort', search.sort);
  if (search.direction !== initialSearch.direction) params.set('direction', search.direction);
  return params;
}

function readBooleanParam(value: string | null): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function readEnumParam<T extends string>(
  value: string | null,
  values: readonly T[],
): T | undefined {
  return values.find((option) => option === value);
}

function hasPanelFilters(search: CatalogueSearch): boolean {
  return Boolean(
    search.collectionId ||
      search.tagId ||
      search.favorite !== undefined ||
      search.format ||
      search.source ||
      search.printed !== undefined ||
      search.direction !== initialSearch.direction,
  );
}

function hasMoreFilters(search: CatalogueSearch): boolean {
  return Boolean(
    search.collectionId ||
      search.tagId ||
      search.source ||
      search.direction !== initialSearch.direction,
  );
}

function hasFilters(search: CatalogueSearch): boolean {
  return Boolean(
    search.query ||
      search.collectionId ||
      search.tagId ||
      search.favorite !== undefined ||
      search.format ||
      search.source ||
      search.printed !== undefined,
  );
}

type FilterKey = 'query' | 'collectionId' | 'tagId' | 'favorite' | 'format' | 'source' | 'printed';

function filterChips(
  search: CatalogueSearch,
  tags: readonly Tag[],
  collections: readonly Collection[],
): Array<{ readonly key: FilterKey; readonly label: string }> {
  const chips: Array<{ key: FilterKey; label: string }> = [];
  if (search.query) chips.push({ key: 'query', label: `Search: ${search.query}` });
  if (search.collectionId) {
    const collection = collections.find((item) => item.id === search.collectionId);
    chips.push({ key: 'collectionId', label: `Collection: ${collection?.name ?? 'Selected'}` });
  }
  if (search.tagId) {
    const tag = tags.find((item) => item.id === search.tagId);
    chips.push({ key: 'tagId', label: `Tag: ${tag?.name ?? 'Selected'}` });
  }
  if (search.favorite !== undefined) {
    chips.push({ key: 'favorite', label: search.favorite ? 'Favorites' : 'Not favorites' });
  }
  if (search.format) chips.push({ key: 'format', label: `Format: ${search.format.toUpperCase()}` });
  if (search.source) {
    chips.push({ key: 'source', label: search.source === 'upload' ? 'Uploaded' : 'Yuki export' });
  }
  if (search.printed !== undefined) {
    chips.push({ key: 'printed', label: search.printed ? 'Printed' : 'Never printed' });
  }
  return chips;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}
