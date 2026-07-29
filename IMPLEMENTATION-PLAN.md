# 3D Print Organizer — MVP Implementation Plan

## 1. Planning model

This plan decomposes the MVP into tasks organized by product feature. Dependencies form a directed acyclic graph (DAG): an implementation task may start only when every task in its **Blocked by** column is complete and integrated.

### Execution status

| Task | Status | Note |
| --- | --- | --- |
| F01 | Complete | Workspace/toolchain verified on Node.js 24.18.0 and pnpm 11.15.1 |
| F02 | Complete | Compose topology validated with a live PostgreSQL/proxy startup |
| F03 | Complete | API and worker bootstrap validated through compiled process smoke tests |
| F04 | Complete | React shell, routing, query provider, error boundary, tests, and production build verified |
| F05 | Complete | PostgreSQL/Kysely foundation passed 27 tests against PostgreSQL 17.5 |
| F06 | Complete | HTTP validation, errors, OpenAPI, CSRF, streaming, and SSE verified |
| F08 | Complete | Local BlobStore and reference-aware lifecycle passed filesystem and PostgreSQL tests |
| F09 | Complete | Structured logging, metrics, health, and authenticated diagnostics verified |
| F10 | Complete | Versioned protocol and restricted container probe verified |
| F11 | Complete | Authenticated UDS supervisor, SHA-pinned restricted containers, streamed checksums/cleanup, read-only worker socket mount, and real detect/extract/preview container checks verified |
| F07 | Complete | Durable jobs passed concurrency, lease, retry, recovery, and dead-letter tests |
| I01 | Complete | Identity and runnable API composition passed PostgreSQL authentication/CSRF tests |
| C01 | Complete | Catalogue invariants and migrations 0001–0004 passed full PostgreSQL tests |
| I02 | Complete | First-run, sign-in/out, authenticated routing, and session-expiry recovery verified |
| C02 | Complete | Authenticated catalogue workflows and runnable API composition verified |
| C03 | Complete | Indexed, owner-scoped search/filter/sort API with deterministic cursors and 10,000-model query-plan coverage |
| C04 | Complete | Catalogue browse/detail/edit, taxonomy filters, favorites, collections, version restore, and lazy generated-thumbnail cards with explicit fallbacks are composed at the root route |
| C05 | Complete | Bounded STL/OBJ/3MF/STEP-to-GLB and G-code layer conversion, dimensions, thumbnails, restricted worker dispatch, APIs, and interactive rendering are composed; real Open Cascade STEP conversion passed in the production processor image |
| C06 | Complete | Strict streaming export/re-import now preserves published versions/assets, ready generated artifacts, immutable print history/audits/photos, and fresh portable relationships; full PostgreSQL round-trip and repository checks pass |
| C07 | Complete | Owner-scoped original downloads stream immutable bytes with range support; durable browser uploads now publish processed batches as new immutable versions while preserving prior versions |
| M01 | Complete | Streaming upload, durable import sessions, atomic publication, and worker composition verified |
| M02 | Complete | Restricted processor ZIP extraction rejects traversal, links, bombs, collisions, encryption, and configured limits |
| M03 | Complete | Restricted processor detection, bounded metadata, duplicate warnings, and atomic partial-failure reporting verified |
| M07 | Complete | Secure supervisor adapters are composed in the worker, report/duplicate APIs are composed in the API, PostgreSQL regressions pass, and real container detection/extraction passes |
| M06 | Complete | Authenticated drag/drop upload, progress, polling, per-file warnings/failures, exact-duplicate confirmation, cancellation, and published-model navigation verified |
| P01 | Complete | Encrypted owner-scoped printer configuration, SSRF-aware verification, profile v1, and normalized OctoPrint gateway verified |
| P02 | Complete | Durable observations, freshness/history, startup/periodic scheduling, reconnect reconciliation, APIs, and worker composition verified |
| P03 | Complete | Bounded parser, backend fact validation, and the read-only restricted-supervisor operation are composed with conservative unknown results for unsafe inference |
| P04 | Complete | Rule set 1.0.0, immutable owner-scoped input/result snapshots, hard conflicts, overridable warnings/unknowns, and PostgreSQL persistence verified |
| P05 | Complete | Durable evaluation, owner-scoped queue APIs, atomic per-printer positions/reordering/removal, override policy, restart-safe worker processing, and PostgreSQL concurrency verified |
| P06 | Complete | Single-use readiness challenges, atomic attempt/command creation, streamed OctoPrint upload and verification, remote start, ambiguous-result reconciliation, and worker/API composition passed PostgreSQL tests |
| P07 | Complete | Single-use fresh-state confirmations, durable pause/resume/cancel/temperature/home commands, bounded OctoPrint dispatch, ambiguous-result reconciliation, and append-only printer/attempt audits passed PostgreSQL tests |
| P08 | Complete | Printer configuration, stale-aware monitoring, compatibility queues, confirmed starts/controls, same-origin webcam proxying, and PostgreSQL-backed SSE invalidation are composed and verified |
| P09 | Complete | Immutable snapshots and append-only audit revisions, manual/external attempts, terminal reconciliation, outcome corrections, notes, reference-safe photos, model projections, failed-history filtering, and APIs passed PostgreSQL tests |
| P10 | Complete | Model pages now show print projections and chronological attempts with exact-version manual entry; global printer-filtered history supports outcome corrections, notes, and result-photo upload |
| N01 | Complete | Terminal print and active-job disconnect transitions atomically create owner-scoped in-app notifications and durable external-delivery jobs; read-state APIs and PostgreSQL rollback/deduplication tests pass |
| N02 | Complete | Generic HTTPS webhooks now have encrypted owner configuration, public-address and DNS-pinned delivery controls, durable bounded retries, sanitized diagnostics, worker/API composition, and an installation settings UI |
| N03 | Complete | The authenticated shell now shows a five-second live unread badge; the notification center supports unread filtering, per-item read state, mark-all-read, event context links, and tested error/empty states |
| S01 | Complete | Authenticated versioned settings persistence, API, installation UI, configuration-surface links, migration, and PostgreSQL/frontend tests verified |
| S02 | Complete | Installation-wide local/S3 selection, validated vendor-neutral configuration, bounded multipart streaming, integrity/range/signing behavior, private MinIO deployment, and the shared contract suite passed against real MinIO |
| M04 | Complete | Feasibility ADR led to the decision to defer Thangs import beyond the MVP |
| O02 | Complete | Hostile parser/archive, mapped-IPv6 SSRF, URL-credential redaction, CSRF, expiring single-use confirmation, and non-root/read-only container checks pass; live migration, API, frontend, and processor image probes verified |
| O04 | Complete | The 10,000-model/30,000-version/30,000-asset reference dataset with 100,000 relationships, 5,000 attempts, and 8,000 thumbnail states passes real loopback API, browser usability, and indexed-plan budgets; the slowest measured API page was 25.8 ms |
| O03 | Complete | Writer-draining Compose commands now produce and clean-restore verified PostgreSQL/local packages or S3 inventories; isolated dump/restore, migration, object-integrity, and API-readiness rehearsal passed |
| O01 | Complete | Disposable full-Compose Playwright runner, clean-install owner setup/sign-in project, reusable authenticated fixture, failure artifacts, and representative core navigation passed in Chrome |
| O05 | Ready | O01 completed the final release-validation prerequisite |

All tasks not listed above remain blocked by the DAG.

### Deferred work

| ID | Decision | MVP effect |
| --- | --- | --- |
| M05 | Direct Thangs import is deferred; see `docs/ADR-0001-thangs-public-import.md` | Removed from the MVP DAG and release criteria; manual file/ZIP import remains in scope |

The **Blocks** column is the reverse edge list. `Blocked by` is the source of truth if the plan changes; both columns must be updated together.

Tasks are intended to produce a tested, usable increment rather than one horizontal layer. A task may modify more than one component when that is necessary to complete its behavior, but it has one owning feature and one primary agent.

The headings below are planning groups, not a request to create another directory for every heading. For example, notification tasks live under the coarse-grained `printing` feature defined in the architecture unless their implementation later justifies a split.

### Components

| Code | Component | Path |
| --- | --- | --- |
| FE | Browser frontend | `frontend/` |
| BE | Backend API/worker artifact | `backend/` |
| DB | PostgreSQL schema/migrations | `backend/migrations/` and the owning backend feature |
| PROC | Restricted file processor | `processor/` |
| DEP | Local/production deployment | `deploy/` |
| DOC | Specifications and operational documentation | `docs/` and root Markdown files |

## 2. Task catalogue and DAG edges

### 2.1 Foundation

| ID | Task and completion condition | Components | Blocked by | Blocks |
| --- | --- | --- | --- | --- |
| F01 | Initialize the TypeScript workspace, formatting, linting, test commands, and reproducible dependency lock. All empty artifacts build in CI. | FE, BE, PROC | — | F02, F03, F04 |
| F02 | Add the development Compose topology and private network with PostgreSQL, proxy, persistent volumes, and health checks. A clean checkout starts predictably. | DEP | F01 | F05, F09, F10, F11, O01 |
| F03 | Bootstrap backend configuration and the API/worker entry points. Both commands start, validate configuration, and shut down cleanly. | BE | F01 | F05, F06, F08, F09, F10, F11, M04 |
| F04 | Bootstrap the React application, routing, query client, error boundary, and test harness. A production bundle is emitted. | FE | F01 | I02, C04, M06, P08, P10, N03, S01, O01 |
| F05 | Implement PostgreSQL connections, transaction helper, typed query setup, and ordered migrations. Migration up/down behavior is integration-tested. | BE, DB | F02, F03 | F07, I01, C01, P01, P05, N01, O03 |
| F06 | Implement HTTP conventions: validation, errors, request IDs, streaming, OpenAPI generation, idempotency keys, CSRF hook, and SSE transport. | BE | F03 | I01, C02, C03, M01, P01, P05, P08, P09, S01, O01 |
| F07 | Implement the PostgreSQL-backed job runner, transactional enqueue, leases, retries, progress, and dead-letter state. Restart recovery is tested. | BE, DB | F05 | M01, C05, C06, P02, P03, N01 |
| F08 | Define `BlobStore` and implement staged/committed local filesystem storage with streaming, hashing, reference tracking, and integrity checks. | BE, DB, DEP | F03 | C01, M01, C06, P09, S02, O03 |
| F09 | Add structured logging, redaction, metrics, and readiness/liveness endpoints to API and worker. | BE, DEP | F02, F03 | O05 |
| F10 | Define the versioned processor contract and restricted container runtime with no network, resource limits, disposable workspace, and timeout handling. | BE, PROC, DEP | F02, F03 | F11, M02, M03, M07, C05, P03, O02 |
| F11 | Implement a narrow host-side processor supervisor with authenticated local IPC, digest allow-listing, fixed mount roots, concurrency limits, timeouts, and no Docker socket or elevated privilege in API/worker containers. Compose end-to-end import and preview jobs pass through it. | BE, DEP, DOC | F02, F03, F10 | M07, C05 |

### 2.2 Identity

| ID | Task and completion condition | Components | Blocked by | Blocks |
| --- | --- | --- | --- | --- |
| I01 | Implement first-user setup, Argon2id login, sessions, owner context, CSRF enforcement, and master-key-backed secret encryption. API integration tests cover setup and session expiry. | BE, DB | F05, F06 | I02, C01, C02, M01, P01, P06, S01, O02 |
| I02 | Implement first-run setup, sign-in, sign-out, and expired-session UI flows. | FE | F04, I01 | O01, O05 |

### 2.3 Catalogue

| ID | Task and completion condition | Components | Blocked by | Blocks |
| --- | --- | --- | --- | --- |
| C01 | Add catalogue-owned schema and persistence for models, immutable versions, assets, stored objects, tags, collections, favorites, and current version. Constraints enforce invariants. | BE, DB | F05, F08, I01 | C02, C03, M01, C05, C06, P04 |
| C02 | Implement authenticated model CRUD, tag/collection/favorite management, immutable version creation, current-version restoration, and deletion-policy hooks. | BE, DB | F06, I01, C01 | C04, C06, C07, P09 |
| C03 | Implement indexed search, filtering, deterministic cursor pagination, sorting, and print-count/last-printed projections. Query plans pass the reference-dataset budget. | BE, DB | F06, C01 | C04, O04 |
| C04 | Implement catalogue browse, search/filter/sort, model details/editing, tags, collections, favorites, and version-history UI. | FE | F04, C02, C03 | O04, O05 |
| C05 | Generate bounded GLB previews, dimensions, thumbnails, and G-code layer artifacts; render them interactively and show explicit failure/unsupported states. Original assets are never changed. | FE, BE, PROC | F07, F10, F11, C01, M02, M03 | C06, O02, O04, O05 |
| C06 | Define the versioned export manifest and implement streaming model export plus validated re-import preserving versions, assets, metadata, artifacts, and print history. | BE, DB, DOC | F07, F08, C01, C02, M02, C05, P09 | O03, O05 |
| C07 | Add authenticated original-asset downloads and a browser-ready upload workflow that publishes a new immutable version through the import processor. | BE, DB | C02, M07 | O05 |

### 2.4 Importing

| ID | Task and completion condition | Components | Blocked by | Blocks |
| --- | --- | --- | --- | --- |
| M01 | Implement import sessions and streaming local upload into quarantine/staging, including SHA-256, configurable limits, progress, failure state, and atomic model publication. | BE, DB | F06, F07, F08, I01, C01 | M02, M03, M07, P03 |
| M02 | Implement safe ZIP inspection/extraction with traversal, link, member-count, expansion-size, and compression-ratio defenses while retaining the original archive. | BE, PROC | F10, M01 | C05, C06, M07, O02 |
| M03 | Implement format/MIME detection, asset metadata extraction, exact-duplicate warnings, retryable processing, and clean partial-failure reporting. | BE, PROC | F10, M01 | C05, M07 |
| M04 | Complete a time-boxed Thangs feasibility and legal/technical integration spike. Record the supported mechanism or a release blocker in an ADR. | BE, DOC | F03 | — |
| M07 | Integrate archive extraction and file detection into the durable local-import worker, persist per-file reports and duplicate decisions, retain originals, commit extracted assets, and publish only after the complete batch succeeds. | BE, DB, DEP | F10, F11, M01, M02, M03 | C07, M06 |
| M06 | Implement local file and archive import UI with progress, warnings, duplicate decisions, and actionable failures. | FE | F04, M07 | O05 |

### 2.5 Printing

| ID | Task and completion condition | Components | Blocked by | Blocks |
| --- | --- | --- | --- | --- |
| P01 | Implement printer configuration, encrypted credentials, connection verification, profile schema, and normalized OctoPrint gateway with contract tests. | BE, DB | F05, F06, I01 | P02, P04 |
| P02 | Implement printer polling, observation freshness, active-job detection, startup/reconnect reconciliation, and external-job handling. | BE, DB | F07, P01 | P06, P08 |
| P03 | Implement bounded G-code parsing for preview and compatibility facts, including build bounds and recognized target/flavor/nozzle/extruder metadata. | BE, PROC | F07, F10, M01 | P04 |
| P04 | Define the versioned compatibility rule table and implement compatible/warning/unknown/hard-incompatible evaluation with immutable snapshots. | BE, DB, DOC | C01, P01, P03 | P05 |
| P05 | Implement persistent per-printer queues, atomic ordering/reordering, removal, concurrency protection, and queue APIs. | BE, DB | F05, F06, P04 | P06, P08 |
| P06 | Implement readiness-confirmation tokens, G-code upload/start orchestration, ambiguous-result reconciliation, and automatic print-attempt creation. | BE, DB | I01, P02, P05 | P07, P09, N01 |
| P07 | Implement confirmed pause, resume, cancel, temperature, and supported basic controls with fresh-state validation and audit events. | BE, DB | P06 | O02, O05 |
| P08 | Implement printer configuration/status, stale-data indicators, queues, compatibility results, readiness confirmation, monitoring, webcam, and controls UI using REST/SSE. | FE, BE | F04, F06, P02, P05 | O05 |
| P09 | Implement immutable print history, manual attempts, outcome corrections, notes, photographs, model projections, and history APIs. | BE, DB | F06, F08, C02, P06 | C06, P10, O04, O05 |
| P10 | Implement model/printer history UI, manual attempt recording, outcome correction, notes, and photograph upload. | FE | F04, P09 | O05 |

### 2.6 Notifications

| ID | Task and completion condition | Components | Blocked by | Blocks |
| --- | --- | --- | --- | --- |
| N01 | Implement in-application notifications and a transactional delivery outbox for print completion, failure, cancellation, and disconnect events. | BE, DB | F05, F07, P06 | N02, N03 |
| N02 | Implement the selected external notification adapter with encrypted configuration, bounded retries, and delivery diagnostics. | BE, DB | N01 | O05 |
| N03 | Implement notification list, unread state, and live update UI. | FE | F04, N01 | O05 |

### 2.7 Settings and storage

| ID | Task and completion condition | Components | Blocked by | Blocks |
| --- | --- | --- | --- | --- |
| S01 | Implement authenticated installation settings for limits, retention, authentication mode, notifications, and printer/storage configuration surfaces. | FE, BE, DB | F04, F06, I01 | S02, O05 |
| S02 | Implement the S3-compatible `BlobStore`, configuration validation, multipart streaming, checksum/existence checks, and local/S3 contract suite. | BE, DEP | F08, S01 | O03, O05 |

### 2.8 Cross-cutting release work

| ID | Task and completion condition | Components | Blocked by | Blocks |
| --- | --- | --- | --- | --- |
| O01 | Establish Playwright acceptance infrastructure from a clean Compose installation, including reusable login/setup fixtures. Feature tasks add scenarios to it. | FE, BE, DEP | F02, F04, F06, I02 | O05 |
| O02 | Run the security hardening pass: hostile parser corpus, archive attacks, SSRF, secret/log review, container permissions, CSRF, and safety confirmation tests. | BE, PROC, DEP | I01, F10, M02, C05, P07 | O05 |
| O03 | Implement and test maintenance-mode backup and clean-install restore for PostgreSQL plus local/S3 objects, with separate master-key guidance. | BE, DEP, DOC | F05, F08, C06, S02 | O05 |
| O04 | Seed the 10,000-model reference dataset, measure library usability, inspect query plans, and tune indexes/projections to meet the two-second target. | FE, BE, DB | C03, C04, C05, P09 | O05 |
| O05 | Execute every MVP acceptance criterion, restart/recovery scenarios, upgrade rehearsal, and release documentation. No unresolved critical defect or undecided release blocker remains. | FE, BE, PROC, DEP, DOC | F09, I02, C04, C05, C06, M06, P07, P08, P09, P10, N02, N03, S01, S02, O01, O02, O03, O04 | — |

## 3. Scheduling the DAG

The scheduler should not assign work by document order. It maintains a ready queue:

1. A task is **ready** when every `Blocked by` task is complete, reviewed, and integrated.
2. Among ready tasks, prefer critical-path tasks with the most downstream blockers.
3. Do not run two tasks concurrently if they own the same feature files, migration number, generated contract, package lock, or composition root.
4. Reserve shared integration files for one integration owner. Feature agents expose registration functions instead of all editing `api-main.ts` or `worker-main.ts`.
5. After a task lands, run its focused tests and the affected artifact's full test/build checks before releasing its blocked tasks.
6. If implementation discovers a new dependency, update both edge columns before continuing. Never work around a missing prerequisite with temporary duplicate infrastructure.

The first useful concurrency points are:

```text
F01
 |-- F02 --+-- F05 --+-- F07
 |         |         +-- catalogue/identity foundations
 |         `-- F10 ----- processor and hostile-file work
 |-- F03 --+-- F06 ----- HTTP-facing feature work
 |         +-- F08 ----- storage-facing feature work
 |         `-- M04 ----- completed scope-decision spike
 `-- F04 -------------- frontend shell, then feature UIs
```

After `F05`, `F06`, `F07`, `F08`, `F10`, `I01`, and `C01` land, catalogue/importing and printer foundations can advance largely in parallel. UI tasks deliberately wait for stable backend contracts rather than inventing duplicate client-side models.

A topological sort currently produces the following dependency waves. These show theoretical readiness, not mandatory sprint boundaries; the coordinator must still honor file ownership and the available-agent limit.

```text
0:  F01
1:  F02 F03 F04
2:  F05 F06 F08 F09 F10 M04
3:  F07 F11 I01
4:  I02 C01 P01 S01
5:  C02 C03 M01 P02 S02 O01
6:  C04 M02 M03 P03
7:  C05 M07 P04
8:  C07 M06 P05
9:  P06 P08
10: P07 P09 N01
11: C06 P10 N02 N03 O02 O04
12: O03
13: O05
```

## 4. Agent assignment contract

One agent receives one ready task at a time. The coordinator supplies an assignment packet using this template:

```text
Task: <ID — exact title>
Objective: <observable outcome from the task catalogue>
Owning feature: <feature>
Allowed components/paths: <explicit paths>
Completed prerequisites: <IDs and relevant public contracts>
Do not modify: <paths owned by concurrent tasks>
Requirements: <MVP-REQUIREMENTS.md sections>
Architecture constraints: <relevant ARCHITECTURE.md sections>
Acceptance checks: <tests, build, and manual behavior>
Deliverables: implementation, focused tests, migration/contract notes

Work only on this task. Keep behavior and tests in the owning feature. Do not
create generic model/service/repository folders, duplicate prerequisite code,
or change a cross-feature public contract without reporting the need first.
Use additive migrations. Preserve unrelated workspace changes. At completion,
report changed files, commands run and results, contract/migration changes,
remaining risks, and any newly discovered DAG edge.
```

### Example assignment: safe archive handling

```text
Task: M02 — Safe ZIP inspection and extraction
Owning feature: importing
Allowed paths: backend/src/importing/**, processor/**, focused test fixtures
Completed prerequisites: F10, M01
Do not modify: backend/src/catalogue/**, api-main.ts, worker-main.ts, migrations
Requirements: MVP 5.1 local upload; 7 security and safety
Acceptance checks:
- accepts a valid multipart archive and retains its original bytes;
- rejects traversal, links, excessive members, expansion bombs, and size limits;
- never publishes a partial model;
- processor time/memory failures become sanitized import failures;
- importing and processor test suites pass.
```

### Example assignment: compatibility evaluation

```text
Task: P04 — G-code compatibility evaluator
Owning feature: printing
Allowed paths: backend/src/printing/compatibility/**, docs/ADR-compatibility.md
Completed prerequisites: C01, P01, P03
Do not modify: G-code parser, printer gateway, queue implementation
Requirements: MVP 5.8 and acceptance criteria 9–10
Acceptance checks:
- produces compatible, warning, unknown, or hard-incompatible results;
- unknown blocks by default, warning requires explicit override, hard conflict
  cannot be overridden;
- persists input snapshots and evaluator version;
- table-driven boundary tests document every rule.
```

## 5. Task completion and integration

A task is complete only when:

- its behavior is reachable through the intended artifact, not merely implemented in an unused module;
- focused automated tests pass and relevant artifact builds remain green;
- database changes include forward migration and rollback/recovery guidance;
- public API or processor-contract changes are generated/documented;
- security and failure behavior from the task description is tested;
- no temporary implementation duplicates a blocked task;
- the coordinator has reviewed newly discovered dependencies and released downstream tasks.

Commits should identify the task ID. The DAG tracks implementation readiness; it does not replace code review, integration testing, or the final acceptance gate.
