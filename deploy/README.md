# Development deployment

This directory owns Yuki's Docker Compose development deployment. It starts the
Vite web application, API, import worker, PostgreSQL, and Caddy. A one-shot
service applies pending migrations before the API and worker start.

## Start

Docker Compose automatically reads `deploy/.env` when commands are run from this
directory. The checked-in defaults bind the proxy to the local machine only and
are intended for development.

```sh
cd deploy
cp .env.example .env
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
| `YUKI_MAXIMUM_UPLOAD_BYTES` | `2147483648` | Maximum bytes accepted by one manual upload |
| `YUKI_UPLOAD_PROGRESS_INTERVAL_BYTES` | `1048576` | Uploaded bytes between durable progress updates |
| `YUKI_IMPORT_POLL_INTERVAL_MS` | `1000` | Delay while the import-job queue is empty |
| `YUKI_IMPORT_JOB_LEASE_MS` | `30000` | Lease duration for one claimed import job |

PostgreSQL credentials are composed into the internal database URL. If a
username or password contains URL-reserved characters, percent-encode them in
the corresponding value.

The checked-in keys are only convenient local-development defaults. Generate
independent replacements with `openssl rand -base64 32` before exposing Yuki to
another machine. Changing the master key after storing encrypted secrets makes
those secrets unreadable.

The `postgres_data` and `storage_data` named volumes are the durable application
state. `proxy_data` and `proxy_config` retain Caddy state. The `application` and
`data` networks are internal. The `edge` network contains only the proxy, which
is the sole service publishing a host port.

## Validate

The Compose model can be validated without starting containers:

```sh
docker compose --env-file deploy/.env.example --file deploy/compose.yaml config --quiet
```

Run that command from the repository root. A full start additionally requires a
running Docker engine and access to the pinned Node.js, PostgreSQL, and Caddy
container images.
