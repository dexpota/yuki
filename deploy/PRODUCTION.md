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

PostgreSQL and local object data use Docker named volumes called
`YUKI_POSTGRES_VOLUME_NAME` and `YUKI_STORAGE_VOLUME_NAME`. Choose unique names
for each stack. When these are empty, Compose derives names from the project
name; the default `production` project retains the existing
`production_postgres_data` and `production_storage_data` volumes. Keep those
names when upgrading an existing stack. To place either on a dedicated host
filesystem, create its named volume with a local bind before the first `up`;
for example:

```sh
docker volume create --driver local \
  --opt type=none --opt o=bind --opt device=/srv/yuki/postgres \
  yuki_postgres_data
docker volume create --driver local \
  --opt type=none --opt o=bind --opt device=/srv/yuki/objects \
  yuki_storage_data
```

Create the host directories first and ensure Docker can write to them. Use the
volume names configured in the environment file. PostgreSQL data, local object
bytes, the selected Compose release, deployment environment files, and secrets
are separate persistence or recovery categories. The production web edge is
stateless and has no proxy data volume.

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

## Apply a release update

Download the target release's `release-images.json` and deployment bundle.
Keep the current `.env.release` and all secrets in place. From the deployment
directory, run the one-shot updater with an explicit version and a new backup
destination:

```sh
YUKI_COMPOSE_PROJECT_NAME=production \
  ./deploy/update-release.sh /secure/downloads/release-images.json 0.2.2 \
  /srv/yuki-backups/yuki-before-0.2.2.yuki-backup
```

Set `YUKI_COMPOSE_FILE`, `YUKI_COMPOSE_ENV_FILE`, and
`YUKI_COMPOSE_RELEASE_ENV_FILE` when the Compose file or private environment
files are elsewhere. Keep `YUKI_COMPOSE_PROJECT_NAME` identical to the running
stack name. The updater needs Docker Engine and Compose on the operator's
machine, but no host Node.js installation or persistent Yuki service. It
serializes updates with a lock, checks current health and available space,
validates the manifest and host platform, pulls all four digest-pinned images,
checks their release labels, and runs a restricted processor smoke operation
before creating the verified pre-update backup.

Only after those checks pass does it preserve the previous image selection in
`.env.release.previous`, atomically install the new selection, stop writers,
run the one-shot migration service, and recreate the Compose-managed supervisor
and application. It waits for readiness and runs a G-code operation through the
newly started Compose supervisor. The timestamped command output records the
selected versions and digests, backup location, migration result, readiness,
and any failed stage. Set `YUKI_UPDATE_MIN_FREE_KB` to change the default
1 GiB preflight threshold. If the updater reports an existing lock, confirm no
update process is running before removing the stale
`.env.release.update-lock` directory.

For Portainer-managed stacks, use the same release manifest, private
environment files, Compose project name, and persistent volume names. Run the
one-shot updater from the Docker host with those settings; it updates the
existing Compose project and does not install a Yuki daemon. Do not redeploy
the stack from an older saved image selection after the update.

If preflight, image retrieval, or backup fails, the current stack and release
selection remain in place. If migration or readiness fails, the updater stops
the application services, leaves the verified backup and
`.env.release.previous` available, and reports the failed stage. Use the
previous image selection only when the new schema remains compatible with that
release. If migrations are not backward-compatible, restore the verified
backup into a clean installation with the required secrets and storage
credentials; `deploy/restore.sh` deliberately refuses to restore over an
existing database or object store. Never delete the pre-update backup until
the upgraded installation and a subsequent backup have been verified.

The release gate exercises this same updater from the latest supported release
before the candidate deployment manifest is attached.

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
Pass an absolute backup destination on a filesystem outside the PostgreSQL,
object-storage, and deployment directories. The backup script stops writers,
creates the package with mode `0600`, verifies the completed file, then resumes
services. A non-zero exit reports failure; an incomplete package is removed.

For automated backups on a Linux host, run the one-shot script from the
deployment directory with cron, a systemd timer, or the operator's scheduler.
For example, this daily cron entry stores archives on a separate mounted disk:

```cron
17 2 * * * cd /opt/yuki && YUKI_COMPOSE_FILE=/opt/yuki/deploy/production/compose.yaml YUKI_COMPOSE_ENV_FILE=/secure/yuki/.env.production YUKI_COMPOSE_RELEASE_ENV_FILE=/opt/yuki/deploy/.env.release YUKI_COMPOSE_PROJECT_NAME=production /opt/yuki/deploy/backup.sh /srv/yuki-backups/yuki-$(date +\%F).yuki-backup
```

Configure the scheduler to report non-zero exits to an operator (for cron, set
`MAILTO` to a monitored address) and alert when no new archive appears within
the expected interval. Keep backups on storage outside the volumes they
protect, encrypt that destination, and apply a retention policy appropriate to
the installation. Retention must keep at least one verified backup and must
not delete the only known-good restore point. A practical starting schedule is
30 daily and 12 monthly verified archives; apply pruning only after the new
archive verifies, and retain the latest verified restore point even when it is
older than the normal window. For S3-backed installs, separately
replicate or back up the bucket; the archive verifies referenced objects but
does not copy their bytes. Perform a clean restore rehearsal periodically and
after changing storage or backup configuration.

Restore verifies the archive before extracting data, requires a clean database
and object store, applies pending migrations, verifies every restored object,
and enables API/worker/web only after integrity checks succeed. The full backup
omits environment files and secrets: protect the master key, database and S3
credentials, CSRF key, and release selection separately. Keep the same master
key and storage access available before starting restored application writers.
