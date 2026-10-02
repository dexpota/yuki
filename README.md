# Yuki

Yuki is a self-hosted catalogue and print organizer for 3D-printable models.

## Development prerequisites

- NVM
- Node.js and pnpm versions declared by `.nvmrc` and `package.json`

```sh
nvm install
corepack enable pnpm
pnpm install --frozen-lockfile
```

## Workspace checks

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

## Validate production images locally

With Docker running, build the backend, web, and processor production images
and run their smoke checks with an explicit candidate version:

```sh
make smoke-release-images VERSION=1.2.3
```

This command uses the current commit metadata and does not create a Git tag,
publish images, or create a GitHub release. See
[Production container images](docs/PRODUCTION-IMAGES.md) for the release image
contract and publication process.

## Run the development stack

```sh
cd deploy
cp .env.example .env
docker compose up --detach --build
```

Open <http://127.0.0.1:8080> and create the first owner account. Yuki has no
default application credentials. See [deploy/README.md](deploy/README.md) for
configuration, health checks, rebuilds, and shutdown.

Product scope, architecture, and task dependencies are defined in
`MVP-REQUIREMENTS.md`, `ARCHITECTURE.md`, and `IMPLEMENTATION-PLAN.md`.

## Backend runtime configuration

The API requires `YUKI_DATABASE_URL`, `YUKI_CSRF_KEY`, `YUKI_MASTER_KEY`,
`YUKI_ALLOWED_ORIGINS`, and a dedicated `YUKI_STORAGE_ROOT`. The worker uses
the same database and storage root. Local imports default to a 2 GiB upload
limit, 1 MiB progress updates, a 1 second worker poll interval, and a 30 second
job lease. Override them with `YUKI_MAXIMUM_UPLOAD_BYTES`,
`YUKI_UPLOAD_PROGRESS_INTERVAL_BYTES`, `YUKI_IMPORT_POLL_INTERVAL_MS`, and
`YUKI_IMPORT_JOB_LEASE_MS`.
