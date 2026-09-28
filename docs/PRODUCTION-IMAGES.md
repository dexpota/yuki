# Production container images

Yuki releases publish three public OCI images to GitHub Container Registry:

| Artifact | Image | Runtime purpose |
| --- | --- | --- |
| Backend | `ghcr.io/dexpota/yuki-backend` | API, worker, migrations, and maintenance commands |
| Web | `ghcr.io/dexpota/yuki-web` | Compiled browser assets served by non-root Caddy |
| Processor | `ghcr.io/dexpota/yuki-processor` | Restricted processing of untrusted files |

Production deployment topology, persistence, backup, and host service packaging
are specified separately. This document defines only the release image
contract.

## Release and tag policy

Publishing starts when a GitHub release with an exact `vMAJOR.MINOR.PATCH` tag
is published. The image tag omits the leading `v`; release `v1.2.3` therefore
publishes `:1.2.3`. Pre-release tags, `latest`, moving major tags, and moving
minor tags are not published.

Exact image tags are immutable. The workflow checks that all three tags are
absent before building and refuses to replace an existing tag. If publication
is interrupted after only some images reach the registry, remove those partial
release artifacts before rerunning the workflow; never replace an image from a
completed release.

Each image supports `linux/amd64` and `linux/arm64`. The release workflow runs
the image smoke suite on native GitHub-hosted runners for both architectures
before publication. Native installation and upgrade acceptance remains a
separate release gate.

The three GHCR packages must be configured as public packages before the first
supported release. Registry visibility is an explicit release preflight because
the repository token can publish package content but must not silently change
repository-owner package policy.

## Identity and attestations

All images carry these OCI labels and matching environment values where
applicable:

- semantic version;
- full source revision;
- build creation time;
- source repository.

The workflow requests BuildKit SBOM and maximum-mode provenance attestations
for each multi-platform image. Deployments should resolve the selected tag to
the index digest and pin the processor by digest at its isolation boundary.

Every release receives `release-images.json` as both a workflow artifact and a
GitHub release asset. Its stable v1 shape is defined by
`docs/release-images-v1.schema.json`. It records the release identity, exact
tag, multi-platform index digest, and the `linux/amd64` and `linux/arm64`
platform digests for each image.

## Image smoke checks

`deploy/smoke-release-image.sh` validates locally built or pulled images. The
release workflow checks:

- every image runs as its declared non-root user and contains the expected OCI
  identity;
- the backend can load API, worker, migration, and maintenance entry points and
  perform an Argon2 hash/verify cycle;
- the web image serves the compiled SPA, applies history fallback, and gives
  hashed assets an immutable cache policy;
- the processor retains its LGPL notices, answers its versioned probe, and
  performs a real Open Cascade STEP conversion with no network, a read-only
  root, dropped capabilities, bounded CPU, memory, and PIDs.

For a local candidate build:

```sh
revision=$(git rev-parse HEAD)
created=$(git show --no-patch --format=%cI HEAD)

docker build -f backend/Dockerfile --target production \
  --build-arg VERSION=1.2.3 --build-arg REVISION="$revision" \
  --build-arg CREATED="$created" -t yuki-backend:release-smoke .
docker build -f frontend/Dockerfile --target production \
  --build-arg VERSION=1.2.3 --build-arg REVISION="$revision" \
  --build-arg CREATED="$created" -t yuki-web:release-smoke .
docker build -f processor/Dockerfile --target production \
  --build-arg VERSION=1.2.3 --build-arg REVISION="$revision" \
  --build-arg CREATED="$created" -t yuki-processor:release-smoke .

YUKI_EXPECTED_VERSION=1.2.3 YUKI_EXPECTED_REVISION="$revision" \
  ./deploy/smoke-release-image.sh backend yuki-backend:release-smoke
YUKI_EXPECTED_VERSION=1.2.3 YUKI_EXPECTED_REVISION="$revision" \
  ./deploy/smoke-release-image.sh web yuki-web:release-smoke
YUKI_EXPECTED_VERSION=1.2.3 YUKI_EXPECTED_REVISION="$revision" \
  ./deploy/smoke-release-image.sh processor yuki-processor:release-smoke
```
