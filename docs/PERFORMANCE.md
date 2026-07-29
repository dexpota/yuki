# Reference performance

This note records the repeatable MVP catalogue benchmark and the latest measured
result. The executable benchmark is
`backend/test/performance/catalogue-reference.test.ts`.

## Dataset and target

The fixture uses the complete migration set and contains:

- 10,000 owner-scoped models;
- 30,000 immutable versions and 30,000 assets;
- 50,000 tag plus 50,000 collection relationships;
- 5,000 representative successful and failed print attempts;
- 8,000 thumbnail artifact states, including 7,000 ready immutable thumbnails.

Each catalogue request uses a real loopback HTTP socket and no application or
HTTP response cache. PostgreSQL is analyzed after seeding. The enforced target
is less than two seconds for every bounded page.

## Reference environment

The 2026-07-29 measurement used an Apple M1 Pro with 10 CPU cores and 32 GB host
memory. Docker Desktop 29.6.2 exposed 10 CPUs and approximately 7.75 GiB memory
to a PostgreSQL 17.5 container. The disposable database used a 2 GiB tmpfs.
Yuki used Node.js 24.18.0 and pnpm 11.15.1.

| Uncached catalogue request | Time |
| --- | ---: |
| Default updated page with thumbnail projection | 25.8 ms |
| Full-text search | 13.4 ms |
| Favorite, format, source, printed, and name sort | 7.3 ms |
| Tag and collection relationship filters | 7.2 ms |
| Failed-history filter and last-printed sort | 5.3 ms |
| Deep name cursor | 13.1 ms |

The slowest measured API request was 25.8 ms, leaving substantial headroom
under the two-second target.

## Browser usability and thumbnails

The focused browser component check made a 50-card page usable in 246.5 ms in
the test DOM. Ready thumbnails use same-origin immutable download URLs with
fixed dimensions, lazy loading, and asynchronous decoding. Pending, failed,
unsupported, and missing thumbnails render explicit fallbacks without issuing
per-card status requests. The API obtains thumbnail state in the bounded page
query, avoiding N+1 requests.

The DOM measurement does not claim production image decode or network
throughput. Thumbnail byte transfer is deliberately deferred by native lazy
loading; clean-Compose browser acceptance remains part of O01/O05.

## Query-plan coverage

The benchmark verifies indexed plans for default catalogue ordering, full-text
search, tag relationships, thumbnail lookup, failed-history filtering, and
model print-history ordering. Migration `0020_reference_performance` adds the
missing global, per-model, per-printer, and failed-attempt history indexes.

Run against disposable PostgreSQL:

```sh
YUKI_TEST_DATABASE_URL=postgresql://... \
  pnpm --filter @yuki/backend exec vitest run \
  test/performance/catalogue-reference.test.ts

pnpm --filter @yuki/frontend exec vitest run test/catalogue/pages.test.tsx
```
