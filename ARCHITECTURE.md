# 3D Print Organizer — MVP Architecture

## 1. Purpose and architectural drivers

This document defines the implementation architecture for the product described in [MVP-REQUIREMENTS.md](./MVP-REQUIREMENTS.md). It is the baseline for implementation decisions; it does not expand the MVP scope.

The architecture is driven by these constraints:

- self-hosted, single-user, and usable without cloud services;
- a catalogue of at least 10,000 models with immutable version history;
- large and untrusted file ingestion, conversion, preview, import, and export;
- durable queues and print state across application restarts;
- multiple independently controlled OctoPrint printers;
- local filesystem and S3-compatible storage;
- a path to future multi-user use without paying the operational cost now;
- a small Docker Compose deployment that one person can operate and back up.

## 2. Architecture summary

The MVP will be a **modular monolith**: one codebase and one domain model, deployed as separate web/API and worker processes. PostgreSQL is the system of record. Original files and generated artifacts live in a storage backend, never in the database. Background work is persisted in PostgreSQL and executed by restricted workers.

```text
Desktop browser
  | HTTPS / REST / Server-Sent Events
  v
Reverse proxy
  |--------------------> Web UI (static React application)
  v
Application API (Fastify)
  |-- Catalogue and versioning
  |-- Import/export
  |-- Printer and queue management
  |-- Print history and notifications
  |-- Authentication and settings
  |
  +------ PostgreSQL <-------- Background worker
  |         system of record      |-- import and archive inspection
  |                               |-- metadata and preview generation
  +------ Storage adapter <-------|-- export construction
  |         | local filesystem    |-- notifications
  |         ` S3-compatible       `-- printer polling/reconciliation
  |
  `------ OctoPrint adapter ----------------> OctoPrint instances

Restricted processor container
  `-- geometry, STEP, image, and G-code conversion tools
```

This is deliberately not a microservice architecture. Catalogue operations, immutable versions, queues, and print history require strongly consistent transactions, and the expected scale does not justify distributed transactions or independently operated services. Process separation is used only where it gives a concrete safety or workload benefit.

## 3. Reference technology stack

The following stack is the implementation default. Changing one of these choices requires an architecture decision record (ADR).

| Area | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript on a current Node.js LTS | Shared types and validation across UI, API, and workers |
| Web UI | React, Vite, TanStack Query, Three.js | Desktop SPA, server-state handling, and browser 3D rendering |
| API | Fastify with schema-driven request/response validation | Small, explicit HTTP layer with streaming support |
| Database | PostgreSQL | Transactions, full-text search, JSON support, locking, and durable job coordination |
| Data access | SQL migrations plus a typed query builder | Keeps database behavior visible; avoids hiding locking and search details |
| Background jobs | PostgreSQL-backed job runner | Jobs and domain state survive restarts without an additional Redis dependency |
| Live updates | Server-Sent Events (SSE) plus ordinary REST commands | Monitoring is server-to-client; SSE reconnects easily and is simpler than WebSockets |
| Object storage | Storage interface with local-filesystem and S3 implementations | Required portability without leaking backend details into the domain |
| Edge | Caddy or equivalent reverse proxy | TLS, request limits, static delivery, and one browser origin |
| Packaging | Docker Compose | Required self-hosted installation model |
| Testing | Vitest, API integration tests against PostgreSQL, Playwright | Unit, boundary, and acceptance workflow coverage |

The repository is organized **first by build artifact, then by a small number of product features inside each artifact**. The feature folders are code-organization boundaries, not independently deployed services. Features should remain coarse-grained for the MVP and split only when their size makes that useful.

```text
frontend/               browser artifact
  src/
    catalogue/           library, model details, imports, versions, previews, exports
    printing/            printers, queues, monitoring, controls, history, notifications
    settings/            sign-in/setup and application/printer/storage settings
    shared/              app shell, generated API client, and proven shared UI
backend/                one server artifact and image
  src/
    api-main.ts          HTTP composition root
    worker-main.ts       background-worker composition root
    catalogue/           models, versions, tags, search, previews, and export
    importing/           uploads, archives, Thangs, staging, and import jobs
    printing/            printers, queues, compatibility, control, history, notification
    identity/            first-run setup, sign-in, sessions, and owner context
    settings/            installation and retention configuration
    platform/            database, HTTP, jobs, storage, logs, test support
  migrations/            ordered migration artifacts
processor/              restricted conversion image and tool definitions
deploy/                 Compose, proxy, backup, and restore assets
docs/                   ADRs and export-format specification
```

`frontend` produces the static browser bundle. `backend` produces one container image that is started with either the API or worker command; this is process separation within one modular application, not a service boundary. Both commands reuse the same feature behavior without copying it. `processor` is a separate artifact only because untrusted file conversion needs operating-system isolation. `deploy` contains operational artifacts rather than application code.

Within a feature, related behavior, persistence or transport code, UI, and tests stay close together. Start with files directly in the feature directory; introduce workflow subdirectories such as `browse/` or `versioning/` only when the feature becomes difficult to navigate. Do not pre-create empty architectural layers.

There is deliberately no global `models`, `entities`, `domain`, `data`, `services`, or `repositories` directory. Database rows and API payloads are representations, not a class hierarchy. A feature defines small types beside the behavior that consumes them and exports only stable contracts from `public.ts`. It must not create one class per table or collect passive data classes in a central folder.

Artifact and feature dependency rules are:

- the frontend never imports backend source; it consumes the backend's OpenAPI contract through a generated client;
- the API and worker composition roots register the same backend features but contain no business rules;
- a backend feature may import backend platform capabilities and another feature's `public.ts`, never another feature's internal files;
- backend platform code must not depend on product features;
- the processor is accessed through a versioned, validated process contract and does not import backend business code;
- cross-feature workflows are coordinated by the feature that owns the user action, using a public query/command contract or a persisted event;
- shared code is promoted to the artifact's `platform` or `shared` folder only after at least two real features need the same mechanism; similar-looking business rules remain in their owning features;
- cycles are resolved by moving orchestration to the initiating feature or using an event, not by creating a generic dumping-ground package.

Database ownership follows the backend feature boundaries. Each table has one owning feature, which contains its schema definition and queries. Timestamped executable migrations live together under `backend/migrations` because they belong to the backend artifact and require a single global order; the corresponding schema behavior remains in the owning feature. Cross-feature foreign keys are permitted for required integrity, while cross-feature writes go through the owner rather than reaching into its query files.

## 4. Runtime components

### 4.1 Web UI

The UI is a desktop-oriented SPA served as static assets. It owns presentation state only. Catalogue, queue, compatibility, and safety rules remain server-side.

Three.js renders normalized preview artifacts rather than parsing every source format directly. STL, OBJ, 3MF, and STEP are converted by workers to a constrained preview representation (glTF/GLB plus metadata). G-code is converted to a compact, bounded layer/toolpath representation. The original asset remains available when conversion fails.

### 4.2 Application API

The API is stateless apart from signed session cookies. It:

- authenticates the user and enforces CSRF protection;
- validates requests at the boundary;
- executes short domain transactions;
- streams uploads to quarantine storage while hashing them;
- creates durable background jobs instead of doing expensive work in a request;
- exposes job progress and printer state through SSE;
- streams downloads or issues short-lived S3 download URLs where safe;
- never exposes storage credentials or OctoPrint API keys to the browser.

### 4.3 Background worker

Workers claim durable jobs using PostgreSQL row locking (`FOR UPDATE SKIP LOCKED`). Each job records type, versioned payload, state, attempts, progress, next-attempt time, error code, and timestamps. Handlers must be idempotent or use an idempotency key and transactional outbox.

Work types include:

- local and Thangs import;
- archive inspection and extraction;
- asset metadata extraction and checksum verification;
- geometry/G-code preview and thumbnail generation;
- model export and cleanup;
- OctoPrint upload, polling, and reconciliation;
- external notification delivery;
- integrity scans and retention cleanup.

Domain records remain the source of truth. The job table is a delivery mechanism, not the authoritative print queue or import state.

### 4.4 Restricted processor

File parsers and converters process untrusted input. They run without network access, as a non-root user, with a read-only root filesystem, a disposable working directory, explicit CPU/memory/time limits, and access only to the files needed for one operation.

The processor presents a versioned command contract to the worker. Initial format handling is:

- STL, OBJ, and 3MF: validate, tessellate if required, calculate bounds, and emit GLB;
- STEP: tessellate through an Open Cascade-based tool and emit GLB;
- G-code: bounded parsing of recognized commands and metadata, emitting compatibility facts and a layer preview;
- images: validate, strip unsafe metadata as appropriate, and generate bounded thumbnails.

Specific tools must be selected after a license and malformed-file evaluation. Conversion images are pinned by digest so a deployment upgrade cannot silently change generated output.

### 4.5 OctoPrint integration

All OctoPrint communication goes through a single application port and adapter. The adapter owns authentication, timeouts, retry classification, API-version differences, and response normalization.

The worker polls configured printers at a modest interval while they are idle and more frequently during active jobs. Command endpoints still fetch fresh state before a safety-sensitive transition. Poll results are stored with an `observed_at` timestamp; the UI labels data stale after a configured threshold.

The API proxies webcam snapshots or streams only from the configured printer endpoint. It must validate the destination against the saved printer origin to prevent server-side request forgery. OctoPrint credentials and private URLs are not sent to the browser.

### 4.6 Notification integration

In-application notifications are database records. One external channel is implemented behind a `NotificationSender` port; the default architectural recommendation is a generic outbound webhook because it has no mandatory provider dependency. Delivery uses an outbox, has bounded retries, and never affects print-job state.

## 5. Feature boundaries and data model

Every mutable aggregate includes a UUID, timestamps, and an optimistic concurrency version. All user-owned records include an `owner_id` from the first release even though the installation initially has one user. This avoids a later primary-key redesign; it does not expose multi-user behavior in the MVP.

The diagrams below describe persisted concepts and ownership, not a prescription to implement each box as a data class. In code, invariants and transitions live in the owning feature workflow. Plain records returned by database queries are shaped for that workflow instead of being inflated into universal entity objects.

### 5.1 Catalogue

```text
User 1---* Model *---* Tag
             |
             *---* Collection
             |
             1---* ModelVersion 1---* Asset ---1 StoredObject
             |          |                |
             |          |                `---* GeneratedArtifact
             |          ` immutable metadata snapshot
             ` current_version_id
```

- `Model` contains the current editable catalogue presentation: name, description, source, source URL/remote identifier, creator, license, favorite, cover reference, and denormalized print counters.
- `ModelVersion` is immutable after publication. Its metadata snapshot is versioned JSON plus searchable relational fields. Setting a version as current changes only `Model.current_version_id`.
- `Asset` is an immutable logical attachment with role, format, original filename, detected MIME type, byte size, checksum, and import time.
- `StoredObject` describes one authoritative backend/key, byte size, checksum, and lifecycle state. Separating it from `Asset` allows safe content deduplication while still retaining duplicate logical files and filenames.
- `GeneratedArtifact` contains disposable preview/thumbnail output, generator name/version, status, dimensions or layer summary, and a stored-object reference. It never replaces or modifies its source asset.
- Tags and collections are normalized many-to-many relationships. Names are unique per owner using a normalized comparison value.

Original upload archives are retained as assets with an `original_archive` role. Extracted supported files become separate assets. Unsupported safe archive members may be retained as `other`; rejected members are listed in the import report.

### 5.2 Imports and exports

- `ImportSession` tracks source, staging prefix, progress, warnings, failure reason, and eventual model ID.
- `ExportJob` records the model snapshot, format version, generated object, expiry, and status.

An imported model is assembled in staging and becomes catalogue-visible only in a final database transaction. A failed Thangs or archive import therefore leaves no partially visible model. Cleanup jobs remove abandoned staging objects.

The portable export contains `manifest.json` with a documented schema/version, every version and original asset, generated artifacts, user media, and print-history data. Paths are content-independent and checksums are included. Import validates the entire manifest and all hashes before publishing records. Secrets, internal storage keys, session data, and printer credentials are never exported.

### 5.3 Printing

```text
Printer 1---* PrintJob 1---0..1 PrintAttempt
   |             |                    |
   |             ` exact G-code Asset |
   ` profile snapshot                 ` Model + ModelVersion + Asset + Printer snapshots
```

- `Printer` stores display data, URL, encrypted credential, enabled status, last observation, and a versioned build/compatibility profile.
- `PrintJob` is the durable per-printer queue item. It points to exactly one G-code asset and stores position, compatibility result/snapshot, override decision, and operational state.
- `PrintAttempt` is created atomically when start is accepted. It retains immutable snapshots needed to interpret history even if a printer or model is later renamed or deleted.
- `PrinterObservation` stores the latest normalized state and a bounded history useful for recovery; high-frequency telemetry is not retained indefinitely.
- `Notification` and `NotificationDelivery` separate the user-visible event from external delivery attempts.

Print photographs are ordinary stored objects attached to a print attempt and go through the same validation pipeline as model images.

Hard database constraints enforce one active job per printer, immutable published model versions/assets, nonnegative queue positions, and unique model-version labels where applicable.

## 6. State machines and consistency rules

### 6.1 Import

```text
created -> uploading/downloading -> inspecting -> processing -> publishing -> completed
                |                     |             |
                `---------------------+-------------+-> failed
```

Only `completed` imports expose a newly created model. A retry resumes from verified stored objects and completed artifacts rather than duplicating them.

### 6.2 Print job

```text
queued -> uploading -> uploaded -> starting -> printing <-> paused -> completed
   |          |           |          |           |            `-> failed
   `-> removed            `----------+-----------+-------------> cancelled
                                      `-> reconciliation_required
```

The exact transition names may be refined in code, but these invariants are mandatory:

- queue editing and reordering lock the target printer row;
- only one job per printer may be in a start/active state;
- a start command requires a recent successful compatibility result and a single-use, short-lived readiness confirmation token;
- no next job starts automatically;
- state-changing OctoPrint calls carry an application idempotency key where supported and are otherwise reconciled before retry;
- terminal state is inferred from OctoPrint facts, then the user may correct the print outcome without rewriting the operational event history;
- an unexpected OctoPrint job is displayed as external and can be recorded manually, never silently attached to a queued job.

### 6.3 Compatibility result

Compatibility evaluation produces versioned machine-readable facts and human-readable explanations:

- `compatible`: all required known checks pass;
- `warning`: a known concern can be explicitly overridden;
- `unknown`: required facts are absent; blocked by default but explicitly overridable;
- `incompatible`: a known hard conflict; cannot be overridden.

The evaluator operates on an immutable G-code metadata snapshot and printer-profile snapshot. Its rule-set version and any override justification are stored with the job and attempt.

## 7. Key workflows

### 7.1 File or ZIP import

1. The API creates an import session and streams the upload to a quarantine key while computing SHA-256.
2. It checks configured compressed and raw upload limits, file signature, and duplicate checksums; filename extensions are advisory only.
3. A worker inspects archives without extracting first, rejects traversal, links, excessive member counts, compression-ratio bombs, and total expanded size violations.
4. Accepted members are extracted one at a time into isolated temporary storage, hashed, and committed through the storage adapter.
5. Database rows and preview jobs are created. The original upload remains unchanged.
6. The model is published atomically. Preview failure is recorded on the artifact but does not fail the model import.

### 7.2 Thangs import

1. The API validates and canonicalizes a public Thangs URL.
2. A feature-flagged `ModelSourceImporter` adapter retrieves public metadata and downloadable files using strict host allowlists, redirect limits, timeouts, and byte limits.
3. Downloaded content enters the same quarantine and import pipeline as local uploads.
4. Source attribution and the remote identifier are stored on the model and metadata snapshot.
5. Any failure leaves the session report visible but publishes no model.

The adapter is an optional boundary, not embedded scraping logic. It ships enabled only after technical and legal validation; manual upload does not count as satisfying the Thangs acceptance criterion.

### 7.3 Start and monitor a print

1. Queueing evaluates compatibility and stores its snapshots under a printer lock.
2. On start, the API refreshes printer state and issues a readiness-confirmation challenge describing the printer, file, and warnings.
3. Confirming the challenge atomically creates the print attempt and an upload/start command job.
4. The worker uploads to a namespaced OctoPrint path, verifies the selected file, starts it, and reconciles ambiguous timeouts before retrying.
5. Polling persists observations and publishes SSE invalidation events. Browser reconnects fetch current REST state before resuming events.
6. Completion, failure, or cancellation closes operational timestamps, creates notifications, and asks the user to confirm the physical outcome.

Pause, resume, cancel, and safety-relevant controls follow the same fresh-state, confirmation, command, and reconciliation pattern.

### 7.4 Export and re-import

The export worker reads a repeatable database snapshot, streams referenced objects into a ZIP, writes the versioned manifest last, and stores the result. Re-import first validates paths, schema, checksums, counts, and sizes in staging. Publication maps portable IDs to local IDs in one transaction and preserves all internal relationships.

## 8. API and event design

The external contract is versioned under `/api/v1`. REST resources include:

- `/models`, `/models/{id}/versions`, `/assets`, `/imports`, `/exports`;
- `/tags`, `/collections`, `/search`;
- `/printers`, `/printers/{id}/observations`, `/printers/{id}/queue`;
- `/print-jobs`, `/print-attempts`, `/notifications`;
- `/settings`, `/session`, and `/events` for SSE.

Commands with safety or workflow meaning use explicit action endpoints such as `POST /print-jobs/{id}/start-confirmations` and `POST /print-jobs/{id}/start`, rather than generic state patches. Mutating endpoints accept an idempotency key. Responses use stable error codes, a request ID, and field-level details; raw parser or upstream errors are logged internally and sanitized for users.

SSE messages contain event ID, resource type/ID, revision, and event kind. They are hints to invalidate cached REST data, not a second source of truth. Clients reconnect using `Last-Event-ID`; if the retained event window is exceeded, they perform a full refresh.

Catalogue endpoints use cursor pagination with a deterministic ID tie-breaker. Sort/filter fields are allowlisted. Search uses PostgreSQL full-text indexes over name, description, creator, filenames, tags, and source URL, with trigram indexes for partial filename/name matching. `last_printed_at` and `print_count` are transactionally maintained projections.

## 9. Storage design

Features use a `BlobStore` port with operations for staged write, commit, read/range-read, existence/head, delete, and signed-download creation. Backend keys are opaque and never constructed by feature code.

Objects are addressed internally by SHA-256 plus a collision-safe suffix. A database record is committed only after the object is durable; deletion is asynchronous and only occurs when no live reference remains and the retention period has elapsed. Failed deletion is retryable and visible in an integrity report.

Local storage uses a dedicated mounted volume, atomic rename within a filesystem, and directories partitioned by checksum prefix. S3 uses multipart upload where needed, verifies returned size/checksum, disables public access, and works against the configured endpoint without assuming a cloud vendor.

Uploads, exports, and proxy downloads are streamed with backpressure. No request or worker loads an entire large asset or archive into memory.

## 10. Security and safety

- First-run setup creates the single local user. Passwords use Argon2id. Authentication uses secure, HTTP-only, same-site cookies with rotation and expiry.
- Trusted-network no-auth mode, if implemented, is an explicit startup setting with a persistent warning; it is never inferred from an IP address.
- State-changing browser requests require CSRF tokens and origin validation. A restrictive Content Security Policy and one-origin deployment reduce browser attack surface.
- OctoPrint and S3 credentials are envelope-encrypted with an installation master key supplied through a Docker secret or environment file outside backed-up data volumes. The key is never logged or exported.
- Outbound HTTP uses scheme and hostname allowlists, resolved-address checks, redirect revalidation, private-address policy, timeouts, and response size limits to mitigate SSRF.
- Archive and parser controls follow the isolation rules in section 4.4. G-code parsing never executes commands.
- API and worker containers run non-root, drop Linux capabilities, and mount only required volumes. The API cannot invoke conversion binaries directly.
- Logs redact credentials, cookies, query secrets, and signed URLs. User-visible errors do not contain stack traces.
- Remote start and destructive controls require an explicit confirmation bound to user, printer, job, action, and short expiry. Confirmation is consumed once.
- The product must state that remote software cannot verify physical printer safety. Automatic unattended start is not implemented.

## 11. Reliability, recovery, and observability

### 11.1 Transactional patterns

- Database changes and follow-up work use a transactional outbox/job insert in the same transaction.
- External side effects use stable operation IDs and a recorded intent/result before advancing state.
- Worker leases expire so abandoned jobs can be reclaimed. Exponential backoff and a terminal dead-letter state prevent infinite retry loops.
- Printer reconciliation runs at worker startup, after connectivity recovery, and whenever an external command has an ambiguous result.
- Scheduled integrity scans compare database objects with backend metadata and report missing/inaccessible files without deleting catalogue records.

### 11.2 Health and diagnostics

The deployment exposes authenticated diagnostics plus container health checks for liveness and readiness. Structured JSON logs share request/job/operation IDs. Metrics include request latency, job age/failure, import bytes, storage failures, printer freshness, reconciliation mismatches, and notification failures. Logs and metrics work locally; no hosted telemetry is required.

### 11.3 Backup and restore

A supported backup command enters a short maintenance/read-only window, drains writers, captures a PostgreSQL dump and a consistent storage snapshot/manifest, then resumes service. The local backend can be archived directly; S3 backup records and verifies the referenced object inventory. The installation master key is excluded and must be backed up separately through documented secure instructions.

Restore targets a clean installation, verifies database and object checksums, runs migrations, performs an integrity scan, and only then enables writes. Backup and restore are tested automatically against representative data before stable release.

## 12. Deployment topology

The default Compose project contains:

- `proxy`: the only host-exposed HTTP(S) service;
- `web`: static UI assets, or assets mounted into the proxy;
- `api`: REST, SSE, and download/upload streaming;
- `worker`: background jobs and printer reconciliation;
- `processor`: invoked as restricted, ephemeral jobs or an isolated worker pool;
- `postgres`: persistent database volume;
- `storage`: persistent local asset volume; optional S3 configuration replaces asset writes, not PostgreSQL.

Only the proxy publishes a host port. PostgreSQL and internal services remain on a private Compose network. OctoPrint and optional external notification destinations are the only necessary outbound targets during normal local operation. Thangs and S3 access are enabled only when those features are configured.

Database migrations run as an explicit one-shot deployment step before new application containers become ready. Migrations must be backward-compatible across one rolling deployment boundary, although the default Compose upgrade may briefly stop the application.

## 13. Performance and capacity

The reference performance test dataset contains at least 10,000 models, multiple versions/assets per model, 100,000 catalogue relationships, and representative print history.

Performance rules:

- list pages select summary projections only; they do not join or hydrate all assets and attempts;
- cursor pagination is the default; offset pagination is not used for deep library pages;
- search, common filters, current-version lookup, checksum lookup, queue order, and print-history lookups have explicit indexes verified with query plans;
- thumbnails are bounded and cached with immutable content URLs;
- original assets and exports support streaming and byte ranges;
- expensive counts and last-printed fields are maintained projections;
- worker concurrency is separately configurable for downloads, CPU-heavy conversion, and printer I/O so imports cannot starve monitoring;
- the two-second library target is measured from an uncached API request on documented reference hardware, with browser thumbnail loading evaluated separately.

## 14. Testing strategy

- **Domain tests:** immutable version rules, compatibility classifications, queue transitions, confirmation expiry, and deletion/retention policy.
- **Database integration tests:** constraints, concurrent queue starts/reordering, job leases, search plans, and transactional outbox behavior against real PostgreSQL.
- **Storage contract tests:** the same suite runs against local filesystem and the selected S3-compatible test service (recommended: MinIO in CI).
- **Parser security tests:** malformed corpora, traversal archives, symlinks, decompression bombs, oversized metadata, parser timeouts, and fuzz/property tests.
- **OctoPrint contract tests:** recorded fixtures plus virtual OctoPrint instances for disconnects, timeouts, external jobs, restart reconciliation, and two-printer independence.
- **End-to-end tests:** automate all release acceptance workflows from a clean Compose deployment, including restart and export/re-import.
- **Backup tests:** periodically restore a produced backup and compare database relationships and object checksums.
- **Performance tests:** seed the reference dataset and enforce catalogue/search latency budgets in a stable environment.

## 15. Evolution boundaries

The following ports are intentional extension points:

- `BlobStore` for additional storage backends;
- `ModelSourceImporter` for permitted import sources;
- `PrinterGateway` for OctoPrint and possible future printer systems;
- `NotificationSender` for the selected external channel;
- `PreviewGenerator` for parser/converter replacement;
- ownership columns and authorization policies for future multi-user use.

They are internal interfaces, not separate services. A module should be extracted only after it needs independent scaling/deployment or has a demonstrably stable protocol boundary.

Future multi-user support will additionally require tenant isolation, authorization policy, storage quotas, audit logging, invitation/account flows, and concurrency UX. The presence of `owner_id` is preparation, not a claim that these concerns are already solved.

## 16. Decisions required before implementation

These items remain product or discovery decisions and must become ADRs before their affected feature is implemented:

1. **Thangs integration:** permitted and stable public download mechanism, attribution rules, and feature-disable behavior.
2. **STEP conversion:** exact Open Cascade-based tool, license, supported constructs, image size, and resource limits.
3. **G-code policy:** normalized metadata schema and the rule table separating hard conflicts, warnings, and unknowns.
4. **External notifications:** accept the recommended generic webhook or select email/Telegram and define secret/configuration behavior.
5. **S3 compatibility target:** use MinIO for automated contract tests and name any additional real provider required for release certification.
6. **Resource defaults:** maximum upload, archive member count, expanded archive size, compression ratio, processing time, and export retention.
7. **Deletion policy:** recommended 30-day recoverable tombstone versus immediate purge.
8. **Trusted-network authentication:** whether no-auth mode is shipped; authenticated mode remains the secure default.

## 17. Definition of architecture complete

Before feature implementation begins, the team should add ADRs for the decisions in section 16, define the versioned export JSON schema, and create thin vertical spikes for STEP conversion, G-code compatibility extraction, Thangs download, and OctoPrint reconciliation. These are the highest-risk boundaries. The rest of the system should then be delivered as end-to-end slices—import, catalogue, version/export, printer queue, monitoring/history—rather than as disconnected technical layers.
