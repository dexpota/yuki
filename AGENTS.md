# Yuki agent guide

This file is the durable handoff for anyone working in this repository. Keep it
short and stable: product scope belongs in `MVP-REQUIREMENTS.md`, architectural
decisions belong in `ARCHITECTURE.md` or an ADR, and task state belongs in
`IMPLEMENTATION-PLAN.md`.

## Start every session here

1. Run `git status --short --branch` and `git log --oneline -10`. Work on
   `develop`. Preserve changes you did not make; never reset or discard them.
2. Read the execution-status table at the top of `IMPLEMENTATION-PLAN.md`.
   Locate the assigned task in the task catalogue and verify all `Blocked by`
   tasks are complete before implementing it.
3. Read the relevant requirements in `MVP-REQUIREMENTS.md`, the applicable
   sections of `ARCHITECTURE.md`, and any related ADR in `docs/`.
4. Inspect the owning feature and its tests before proposing new abstractions.
   Existing code is evidence; planning documents are the intended design.
5. If documents and code disagree, stop and explain the discrepancy. Do not
   silently redesign the product or duplicate infrastructure.

When asked to "continue" without a task ID, choose only a task that is ready in
the DAG. Prefer a critical-path task with useful user-visible value, state the
choice, and update the execution-status table when it is integrated.

## Product and architecture

Yuki is a self-hosted, single-user catalogue and print organizer for
3D-printable models. The MVP is a **modular monolith**, not a microservice
system:

- `frontend/`: React/Vite browser artifact.
- `backend/`: one Fastify/TypeScript artifact, run as separate API and worker
  processes through `api-main.ts` and `worker-main.ts`.
- `processor/`: restricted, short-lived handling of untrusted model, archive,
  image, and G-code files.
- `deploy/`: Docker Compose, Caddy, and processor-supervisor integration.
- `backend/migrations/`: globally ordered PostgreSQL migrations.
- `docs/`: ADRs and stable format specifications.

Code is organized first by deployable artifact and then by coarse product
feature. Keep behavior, contracts, persistence, UI, and focused tests with the
owning feature:

- Backend features: `catalogue`, `importing`, `printing`, `identity`, and
  `settings`; reusable technical mechanisms live in `platform`.
- Frontend features: `catalogue`, `importing`, and `settings`; proven reusable
  browser code lives in `shared`.
- Processor features: `archive`, `detection`, `gcode`, and `preview`.

Do not create global `models`, `entities`, `domain`, `data`, `services`, or
`repositories` directories, and do not collect passive data classes in one
place. Add small types beside the behavior that uses them. Do not create a new
directory for every task ID.

The frontend never imports backend source. A backend feature may use platform
code and another feature's public entry point, but must not deep-import another
feature's internals. Composition roots wire features and contain no business
rules. Promote code into `platform` or `shared` only after at least two real
features need the same technical mechanism.

PostgreSQL is the system of record. Large originals and generated artifacts
belong in the `BlobStore`, not database byte columns. Published model versions
and assets are immutable. Expensive or restart-sensitive work uses durable
PostgreSQL jobs. Treat all imported files and printer endpoints as untrusted.

## Current handoff snapshot

The authoritative live status is the table in `IMPLEMENTATION-PLAN.md`; update
it as work lands. At commit `c9257e3`:

- Manual local import (M06/M07) works end to end, including upload progress,
  duplicate decisions, polling, error reporting, and selecting the same file
  for another import.
- Docker Desktop import processing uses the authenticated loopback TCP
  supervisor plus the narrow `processor-bridge`. Native deployments retain
  Unix-socket transport. Read `docs/ADR-0003-import-processor-deployment.md`
  before changing this boundary.
- Thangs import is deliberately outside the MVP; see ADR-0001.
- C05 is in progress. C07 is ready. By the recorded DAG, P04, S02, and O01 also
  have completed prerequisites. C06 remains blocked on unfinished preview and
  print-history work even though its core portability implementation exists.
- The latest full recorded verification was 126 backend tests passing with 43
  database-dependent tests skipped, 51 processor tests, and 20 frontend tests.
  Do not treat this snapshot as proof after making changes—run relevant checks.

Never assume a previously started host supervisor or Compose process is still
running in a new session. Inspect runtime state first.

## Toolchain and routine checks

Use the pinned Node and pnpm versions:

```sh
source "$HOME/.nvm/nvm.sh"
nvm use
corepack enable pnpm
pnpm install --frozen-lockfile
```

Prefer focused checks while iterating:

```sh
pnpm --filter @yuki/frontend typecheck
pnpm --filter @yuki/frontend exec vitest run test/path/to/test.tsx

pnpm --filter @yuki/backend typecheck
pnpm --filter @yuki/backend exec vitest run test/path/to/test.ts

pnpm --filter @yuki/processor typecheck
pnpm --filter @yuki/processor exec vitest run test/path/to/test.ts
```

Before handing off an integrated task, run the affected artifact's full tests
and build, then the relevant repository checks:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
git diff --check
```

Backend suites guarded by `YUKI_TEST_DATABASE_URL` are integration tests and
skip without a disposable PostgreSQL database. Report pass and skip counts
honestly. Database or transactional changes are not verified until their
integration tests run against PostgreSQL.

Use Biome for formatting. Add focused tests beside the artifact's existing test
structure. A task is not complete merely because an isolated module exists: it
must be wired into the intended composition root and reachable through its real
API, worker, or UI path.

## Running the application

There are no default application credentials. A fresh installation asks for
the first owner account; its password must contain at least 12 characters.
Development-only infrastructure secrets are documented in `deploy/.env.example`.

Follow `deploy/README.md`. On macOS/Docker Desktop, the essential order is:

```sh
cp deploy/.env.example deploy/.env  # only if deploy/.env does not exist
docker build -f processor/Dockerfile -t yuki-processor:development .
pnpm --filter @yuki/backend build
./deploy/start-processor-supervisor.sh
```

Keep the supervisor running and, in another terminal, run:

```sh
docker compose -f deploy/compose.yaml up --detach --build
docker compose -f deploy/compose.yaml ps
```

Open `http://127.0.0.1:8080`. Health endpoints are `/healthz` and
`/health/ready`. Rebuild only affected services during iteration, for example:

```sh
docker compose -f deploy/compose.yaml up --detach --build web
docker compose -f deploy/compose.yaml up --detach --build api worker
```

Use `docker compose down` to stop without deleting data. Never add `--volumes`
unless the user explicitly intends to erase the local database and stored
assets.

## Change discipline

- Stay within the assigned task and named feature paths. Coordinate edits to
  composition roots, migrations, generated contracts, the lockfile, and
  deployment files.
- Use additive, globally ordered migrations. The owning feature owns schema
  behavior even though migration files share one directory.
- Validate requests and responses at boundaries. Do not leak credentials,
  internal storage keys, host paths, parser output, or stack traces.
- Do not weaken processor isolation, expose the Docker socket, add broad host
  mounts, or let callers choose processor commands or mount paths.
- Preserve originals on import failures and publish catalogue records only
  after the complete batch succeeds.
- Do not silently expand the MVP. Record significant technology or boundary
  changes in an ADR.
- Keep commits scoped and include the task ID where applicable, for example
  `feat(P04): evaluate G-code compatibility`.

## Handoff checklist

Before declaring work complete:

1. Confirm the behavior is wired and its focused acceptance conditions pass.
2. Run affected full tests/builds and record exact results, including skips.
3. Update the `IMPLEMENTATION-PLAN.md` status/note and both DAG edge columns if
   implementation discovered a new dependency.
4. Update requirements, architecture, ADRs, schemas, or deployment docs only
   when their contract actually changed.
5. Check `git status`, preserve unrelated work, and report changed files,
   commands/results, migrations or public-contract changes, risks, and the next
   tasks newly unblocked.
