# Development deployment

This directory owns Yuki's Docker Compose development deployment. It starts the
Vite web application, API, import worker, PostgreSQL, and Caddy. A one-shot
service applies pending migrations before the API and worker start. A narrow
host-side supervisor runs untrusted file processing without exposing the Docker
socket to application containers.

## Start

Docker Compose automatically reads `deploy/.env` when commands are run from this
directory. The checked-in defaults bind the proxy to the local machine only and
are intended for development.

```sh
cd deploy
cp .env.example .env
cd ..
docker build --file processor/Dockerfile --tag yuki-processor:development .
pnpm --filter @yuki/backend build
./deploy/start-processor-supervisor.sh
```

Keep the supervisor running, then start Compose in a second terminal:

```sh
cd deploy
docker compose up --detach --build
docker compose ps
```

Open <http://127.0.0.1:8080>. On a new database Yuki asks you to create the
owner username and password; there are no preset application credentials. The
password must contain at least 12 characters.

The proxy health endpoint is <http://127.0.0.1:8080/healthz>, and API readiness
is <http://127.0.0.1:8080/health/ready>. PostgreSQL, the API, worker, and Vite
server do not publish host ports.

After changing application source, rebuild the affected containers:

```sh
docker compose up --detach --build api worker web
```

To stop the containers without deleting data:

```sh
docker compose down
```

Do not add `--volumes` unless intentionally deleting the local database, stored
assets, and proxy state.

## Configuration

| Variable | Development default | Purpose |
| --- | --- | --- |
| `YUKI_HTTP_BIND_ADDRESS` | `127.0.0.1` | Address on which the proxy publishes HTTP |
| `YUKI_HTTP_PORT` | `8080` | Proxy HTTP port |
| `YUKI_POSTGRES_DB` | `yuki` | Database name |
| `YUKI_POSTGRES_USER` | `yuki` | Database role |
| `YUKI_POSTGRES_PASSWORD` | `yuki-development-only` | Database password; change outside isolated local development |
| `YUKI_CSRF_KEY` | Development-only fixed key | Signs browser CSRF tokens; replace and keep stable |
| `YUKI_MASTER_KEY` | Development-only fixed key | Encrypts installation secrets; replace and keep stable |
| `YUKI_ALLOWED_ORIGINS` | Local Caddy URLs | Exact browser origins accepted for mutations |
| `YUKI_STORAGE_ROOT` | `/data/yuki` | Dedicated local asset-storage root used by API and worker |
| `YUKI_STORAGE_BACKEND` | `local` | Installation-wide object backend: `local` or `s3` |
| `YUKI_S3_ENDPOINT` | `http://minio:9000` | S3-compatible endpoint without credentials or a path |
| `YUKI_S3_REGION` | `us-east-1` | S3 signing region |
| `YUKI_S3_BUCKET` | `yuki` | Existing private object bucket |
| `YUKI_S3_ACCESS_KEY_ID` | Development MinIO user | S3 access-key identifier; keep secret outside development |
| `YUKI_S3_SECRET_ACCESS_KEY` | Development MinIO secret | S3 secret access key; keep stable and private |
| `YUKI_S3_FORCE_PATH_STYLE` | `true` | Use path-style addressing for compatible services such as MinIO |
| `YUKI_S3_MULTIPART_THRESHOLD_BYTES` | `8388608` | S3 multipart part size; minimum 5 MiB |
| `YUKI_S3_SIGNED_DOWNLOAD_TTL_SECONDS` | `300` | Maximum lifetime for a private signed download URL |
| `YUKI_MAXIMUM_UPLOAD_BYTES` | `2147483648` | Maximum bytes accepted by one manual upload |
| `YUKI_UPLOAD_PROGRESS_INTERVAL_BYTES` | `1048576` | Uploaded bytes between durable progress updates |
| `YUKI_IMPORT_POLL_INTERVAL_MS` | `1000` | Delay while the import-job queue is empty |
| `YUKI_IMPORT_JOB_LEASE_MS` | `30000` | Lease duration for one claimed import job |
| `YUKI_PROCESSOR_TOKEN` | Development-only fixed token | Authenticates worker requests to the host processor supervisor; replace and keep stable |
| `YUKI_PROCESSOR_TRANSPORT` | `tcp` | `tcp` for Docker Desktop development; `socket` for native Unix-socket deployments |
| `YUKI_PROCESSOR_PORT` | `3210` | Loopback supervisor and fixed bridge port when the TCP transport is selected |

PostgreSQL credentials are composed into the internal database URL. If a
username or password contains URL-reserved characters, percent-encode them in
the corresponding value.

The checked-in keys are only convenient local-development defaults. Generate
independent replacements with `openssl rand -base64 32` before exposing Yuki to
another machine. Changing the master key after storing encrypted secrets makes
those secrets unreadable.

Local storage is the default. To exercise the optional MinIO-backed S3 contract,
set `YUKI_STORAGE_BACKEND=s3` in `deploy/.env`, start with
`docker compose --profile s3 up --detach --build`; the one-shot `minio-init`
service creates the configured private bucket before the API and worker start.
Existing objects are not migrated when the backend selector changes. Production credentials should be injected through
deployment secrets and must not be committed. The application validates bucket
access on startup and never returns S3 credentials through its settings API.
See `docs/ADR-0006-s3-compatibility-target.md`.

Run the real S3 contract from the host with the test-only loopback overlay:

```sh
docker compose --env-file deploy/.env.example --file deploy/compose.yaml \
  --file deploy/compose.s3-test.yaml --profile s3 up --detach minio minio-init
YUKI_TEST_S3_ENDPOINT=http://127.0.0.1:19000 \
  pnpm --filter @yuki/backend exec vitest run test/storage/s3-blob-store.test.ts
```

The overlay publishes MinIO only on loopback and is not part of the normal
deployment topology.

The processor token must contain at least 32 bytes and must match in the host
supervisor and worker environments. Development defaults to a loopback-only TCP
listener because Docker Desktop cannot consume a Unix socket bind-mounted from
macOS. A fixed, unprivileged bridge forwards only this byte stream from the
internal worker network through Docker's host gateway. The protocol remains
authenticated end to end; the bridge receives no token or Docker socket. Set
`YUKI_PROCESSOR_TRANSPORT=socket` for a native Unix socket deployment. The API,
worker, and bridge never receive `/var/run/docker.sock`. The supervisor resolves
the locally built processor to its immutable image ID before invoking it. See
`docs/ADR-0003-import-processor-deployment.md` for the security boundary.

The `postgres_data` and `storage_data` named volumes are the default durable
application state. `proxy_data` and `proxy_config` retain Caddy state. The
`application` and `data` networks are internal. The `edge` network contains only
the proxy, which is the sole service publishing a host port.

## Validate

The Compose model can be validated without starting containers:

```sh
docker compose --env-file deploy/.env.example --file deploy/compose.yaml config --quiet
```

Run that command from the repository root. A full start additionally requires a
running Docker engine and access to the pinned Node.js, PostgreSQL, and Caddy
container images.
