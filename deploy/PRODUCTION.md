# Production Compose deployment

Yuki's production deployment is one Docker Compose stack. The stack contains
the API, worker, web, PostgreSQL, migrations, and processor supervisor. The
supervisor starts short-lived restricted processor containers as needed. No
Yuki host service or host Node.js installation is required. Docker Engine and
Compose (or a compatible Portainer stack deployment) are required.

Use a release with a `release-images.json` **v2** asset. Earlier v1 releases
do not contain the supervisor image and cannot run this stack. The four Yuki
images must come from the same manifest. Do not mix tags or manually substitute
an image from another release.

## Select and configure a release

Download `yuki-deployment-v2.tar.gz` and `release-images.json` from the same
Yuki GitHub release. Extract the deployment archive into a private directory;
it contains `deploy/` and `docs/` without application source. From that
directory:

```sh
cp deploy/.env.production.example deploy/.env.production
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD,target=/work" --workdir /work \
  node:24.18.0-bookworm-slim \
  node deploy/select-release.mjs release-images.json deploy/.env.release
```

Fill in `deploy/.env.production` with independent private values for the
PostgreSQL password, database URL, CSRF key, master key, processor token, and
allowed browser origin. Generate each key and token independently with
`openssl rand -base64 32`. The database URL must use the same username,
database, and password as the PostgreSQL service; percent-encode reserved
characters in its password. Keep both environment files private and outside
backups of application data. Preserve the master key across upgrades and
restores. Give `YUKI_PROCESSOR_WORKSPACE_VOLUME` a unique name if multiple
stacks share one Docker host.

The production template contains no working secrets. Compose refuses missing
required variables; a one-shot preflight also rejects the checked-in
development secrets and mismatched release identity before PostgreSQL or the
application starts. Select S3 only with a configured private bucket and all
required S3 credentials. Local object storage is the default.

For a local installation, validate and start from the repository root:

```sh
docker compose --env-file deploy/.env.production --env-file deploy/.env.release \
  --file deploy/production/compose.yaml config --quiet
docker compose --env-file deploy/.env.production --env-file deploy/.env.release \
  --file deploy/production/compose.yaml up --detach
docker compose --env-file deploy/.env.production --env-file deploy/.env.release \
  --file deploy/production/compose.yaml ps
```

The default edge bind is `127.0.0.1:8080`. Set `YUKI_HTTP_BIND_ADDRESS` and
`YUKI_ALLOWED_ORIGINS` for the intended browser origin. The included edge
configuration serves HTTP; use a trusted TLS-terminating reverse proxy when
exposing the installation beyond the local machine. No other application
service publishes a host port.

For Portainer, deploy `deploy/production/compose.yaml` as a stack and supply
the variables from the two environment files in its environment settings.
The Compose file has no relative file mounts or application build contexts.
Keep the selected image references at their `@sha256:` digests. Portainer's
stack controls start, stop, recreation, and logs; it does not need a separate
Yuki service installed on the host.

## Operate and inspect

The following examples use the same two `--env-file` options and `--file`
option shown above; substitute your Portainer stack controls when using its
UI.

```sh
docker compose --env-file deploy/.env.production --env-file deploy/.env.release \
  --file deploy/production/compose.yaml ps
docker compose --env-file deploy/.env.production --env-file deploy/.env.release \
  --file deploy/production/compose.yaml logs --tail 100 web api worker supervisor migrate
docker compose --env-file deploy/.env.production --env-file deploy/.env.release \
  --file deploy/production/compose.yaml restart worker supervisor
docker compose --env-file deploy/.env.production --env-file deploy/.env.release \
  --file deploy/production/compose.yaml down
```

`down` preserves named volumes; never add `--volumes` during normal operation.
`up --detach` recreates services after a configuration change without removing
PostgreSQL, object storage, or other persistent state. Check
`http://127.0.0.1:8080/healthz` for the web edge and `/health/ready` for API
readiness at the configured origin. `docker compose ps` shows service health
and the completed migration job. The selected release version and source
revision are in `deploy/.env.release`; `docker image inspect` can display the
OCI labels of each selected digest.

The supervisor alone receives `/var/run/docker.sock`. The worker connects to
its authenticated Unix socket through a separate shared volume. Processor
jobs receive only their own input and output volume subdirectories, not the
Docker socket, application storage, or network access. See
[`ADR-0008`](../docs/ADR-0008-compose-managed-processor-supervisor.md).

## Backup and restore

The existing one-shot backup and clean-install restore scripts can select this
Compose file by setting `YUKI_COMPOSE_FILE` to the absolute path of
`deploy/production/compose.yaml`, `YUKI_COMPOSE_ENV_FILE` to the private
production environment file, and `YUKI_COMPOSE_RELEASE_ENV_FILE` to the
selected release environment file. Set `YUKI_COMPOSE_PROJECT_NAME` when the
stack name differs from the Compose directory name. They do not run as host
services. Follow the data and secret
handling requirements in [`FULL-BACKUP-FORMAT.md`](../docs/FULL-BACKUP-FORMAT.md).
The broader production backup schedule and update workflow are tracked by
issues #4 and #5.
