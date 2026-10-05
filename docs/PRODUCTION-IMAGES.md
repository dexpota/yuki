# Production container images

Releases produced from the Compose-managed supervisor implementation publish
four public OCI images to GitHub Container Registry:

| Artifact | Image | Runtime purpose |
| --- | --- | --- |
| Backend | `ghcr.io/dexpota/yuki-backend` | API, worker, migrations, and maintenance commands |
| Web | `ghcr.io/dexpota/yuki-web` | Compiled browser assets served by non-root Caddy |
| Processor | `ghcr.io/dexpota/yuki-processor` | Restricted processing of untrusted files |
| Supervisor | `ghcr.io/dexpota/yuki-supervisor` | Compose-managed broker for short-lived processor jobs |

Production deployment topology and persistence are specified separately. This
document defines the next release image contract. Existing v1 releases contain
only three images and cannot run the production Compose stack. The fourth image
and v2 manifest follow
[ADR-0008](./ADR-0008-compose-managed-processor-supervisor.md).

## Release and tag policy

Publishing starts when a GitHub release with an exact `MAJOR.MINOR.PATCH` tag
is published. Release `1.2.3` therefore publishes image tag `:1.2.3`.
Pre-release tags, `latest`, moving major tags, and moving minor tags are not
published.

Exact image tags are immutable. The workflow checks that all four tags are
absent before building and refuses to replace an existing tag. If publication
is interrupted after only some images reach the registry, remove those partial
release artifacts before rerunning the workflow; never replace an image from a
completed release. If the workflow itself is defective at the tagged commit,
publish a new patch release from the fix rather than moving the existing tag.

Each image supports `linux/amd64` and `linux/arm64`. The release workflow runs
the image smoke suite on native GitHub-hosted runners for both architectures
before publication. It also builds and pushes each platform on its matching
native runner, then combines the resulting digests into the immutable release
tags. The ARM64 processor build does not run under QEMU. Native installation
and upgrade acceptance remains a separate release gate.

The four GHCR packages must be configured as public packages before the first
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

Every new release receives `release-images.json` and
`yuki-deployment-v2.tar.gz` as workflow artifacts and GitHub release assets.
The deployment archive contains Compose, its secret-free template, the release
selector, and operational documentation without application source. The v2
manifest shape is defined by
`docs/release-images-v2.schema.json`; v1 remains the historical three-image
contract. The manifest records the release identity, exact
tag, multi-platform index digest, and the `linux/amd64` and `linux/arm64`
platform digests for each image.

## Image smoke checks

`deploy/smoke-release-image.sh` validates locally built or pulled images. The
release workflow checks:

- every image has the expected OCI identity; backend, web, and processor run
  as non-root users. The trusted supervisor runs as root only within its
  container so it can access the Docker socket;
- the backend can load API, worker, migration, and maintenance entry points and
  perform an Argon2 hash/verify cycle;
- the web image serves the compiled SPA, applies history fallback, and gives
  hashed assets an immutable cache policy;
- the processor retains its LGPL notices, answers its versioned probe, and
  performs a real Open Cascade STEP conversion with no network, a read-only
  root, dropped capabilities, bounded CPU, memory, and PIDs.
- the supervisor image contains the fixed processor entry point and Docker
  client; a real smoke check sends two concurrent requests from a container
  without Docker access through its authenticated Unix socket and verifies
  job cleanup.

For a local candidate build:

```sh
make smoke-release-images VERSION=1.2.3
```

The target embeds the current commit and its timestamp, builds all four
production images, and runs their smoke checks. It does not create a Git tag,
publish images, or create a GitHub release.
