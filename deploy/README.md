# Development deployment

This directory owns Yuki's Docker Compose deployment. The current foundation
starts the reverse proxy and PostgreSQL independently of application bootstrap.
The API, worker, web, and restricted processor services will join these networks
when their owning implementation tasks provide runnable containers.

## Start

Docker Compose automatically reads `deploy/.env` when commands are run from this
directory. The checked-in defaults bind the proxy to the local machine only and
are intended for development.

```sh
cd deploy
cp .env.example .env
docker compose up --detach
docker compose ps
```

The proxy health endpoint is available at <http://127.0.0.1:8080/healthz> by
default. PostgreSQL does not publish a host port.

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

The `postgres_data` and `storage_data` named volumes are the durable application
state. `proxy_data` and `proxy_config` retain Caddy state. The `application` and
`data` networks are internal. The unprivileged `edge` network contains only the
proxy, which is the only service that publishes a host port.

## Validate

The Compose model can be validated without starting containers:

```sh
docker compose --env-file deploy/.env.example --file deploy/compose.yaml config --quiet
```

Run that command from the repository root. A full start additionally requires a
running Docker engine and access to the pinned container images.
