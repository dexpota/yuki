import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';

import {
  type AssetFormat,
  type CatalogueSearch,
  type CatalogueSort,
  listCollections,
  listTags,
  searchCatalogue,
} from '../api.js';
import '../catalogue.css';

const initialSearch: CatalogueSearch = { sort: 'updatedAt', direction: 'desc' };

export function CataloguePage() {
  const [draft, setDraft] = useState<CatalogueSearch>(initialSearch);
  const [search, setSearch] = useState<CatalogueSearch>(initialSearch);
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
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSearch(draft);
  };

  return (
    <section className="catalogue-page">
      <header className="catalogue-heading">
        <div>
          <p className="eyebrow">Catalogue</p>
          <h1>Your models</h1>
        </div>
      </header>

      <form className="catalogue-filters" onSubmit={submit} aria-label="Catalogue filters">
        <label className="catalogue-search">
          <span>Search</span>
          <input
            type="search"
            value={draft.query ?? ''}
            placeholder="Name, creator, tag, filename…"
            onChange={(event) => setDraft({ ...draft, query: event.target.value })}
          />
        </label>
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
          label="Format"
          value={draft.format ?? ''}
          onChange={(value) =>
            setDraft({ ...draft, format: (value || undefined) as AssetFormat | undefined })
          }
          options={[
            ['', 'Any format'],
            ...['stl', '3mf', 'obj', 'step', 'gcode', 'image', 'document', 'archive', 'other'].map(
              (format) => [format, format.toUpperCase()] as [string, string],
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
          label="Printed"
          value={booleanValue(draft.printed)}
          onChange={(value) => setDraft({ ...draft, printed: optionalBoolean(value) })}
          options={[
            ['', 'Any history'],
            ['true', 'Printed'],
            ['false', 'Never printed'],
          ]}
        />
        <SelectFilter
          label="Sort"
          value={draft.sort}
          onChange={(value) => setDraft({ ...draft, sort: value as CatalogueSort })}
          options={[
            ['updatedAt', 'Recently updated'],
            ['importedAt', 'Import date'],
            ['name', 'Name'],
            ['lastPrintedAt', 'Last printed'],
            ['printCount', 'Print count'],
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
        <div className="catalogue-filter-actions">
          <button type="submit">Apply filters</button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setDraft(initialSearch);
              setSearch(initialSearch);
            }}
          >
            Reset
          </button>
        </div>
      </form>

      {catalogue.isPending ? <Status message="Loading your catalogue…" busy /> : null}
      {catalogue.isError ? (
        <Status
          message="The catalogue could not be loaded."
          action={() => void catalogue.refetch()}
        />
      ) : null}
      {catalogue.isSuccess && items.length === 0 ? (
        <Status message="No models match these filters." />
      ) : null}
      {items.length > 0 ? (
        <ul className="catalogue-grid" aria-label="Models">
          {items.map((model) => (
            <li key={model.id}>
              <Link className="model-card" to={`/catalogue/models/${model.id}`}>
                <span className="model-card-icon" aria-hidden="true">
                  {model.favorite ? '★' : '◇'}
                </span>
                <strong>{model.name}</strong>
                <span>{model.creator || 'Unknown creator'}</span>
                <small>
                  {model.printCount} {model.printCount === 1 ? 'print' : 'prints'} ·{' '}
                  {model.importSource === 'upload' ? 'Uploaded' : 'Yuki export'}
                </small>
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
