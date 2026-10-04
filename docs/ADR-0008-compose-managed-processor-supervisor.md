# ADR-0008: Compose-managed processor supervisor

Status: accepted and implemented in the repository; first v2 release pending

## Context

ADR-0003 established a narrow supervisor between the general worker and the
container runtime. The current development deployment runs that supervisor on
the host and uses a TCP bridge on Docker Desktop. The production issues also
specified a managed host service. That would require operators to install and
manage a process outside the Yuki Compose stack.

Production operators must be able to install and manage all long-running Yuki
services through Docker Compose, including through tools such as Portainer.
They must not need a separate systemd unit, host Node.js installation, or
manually started supervisor.

## Decision

The production supervisor is a dedicated Compose service built from the same
release as the API, worker, web, and processor. It starts automatically, has a
restart policy and health check, and is the only Yuki service with access to
the container-runtime socket. The API and general worker never receive that
socket, broad host mounts, or an unrestricted runtime API endpoint.

The worker communicates with the supervisor over an authenticated Unix-domain
socket in a narrowly shared Docker-managed volume. The supervisor accepts only
the versioned, allowlisted processor operations from ADR-0003. It selects the
processor image by immutable digest and creates short-lived, restricted
processor containers. Docker enforces their network, filesystem, capability,
user, and resource limits.

The supervisor and each processor job exchange files through Docker-managed
storage with a distinct directory for each request. A processor container may
mount only its own input and output directories; input is read-only. The
implementation must verify this on every supported Docker Engine platform,
including isolation between concurrent jobs, cleanup after failure, and socket
permissions. It must not depend on a host path from inside the supervisor
container being interpreted as the same path by the Docker daemon.

The supervisor needs its own versioned container image with the runtime client
it uses to launch processor jobs. Release publication and release metadata must
include this image and verify that all four Yuki images come from the same
source revision. The three-image `release-images.json` v1 contract remains a
historical format; future releases use v2 with the fourth image.

The existing development host-supervisor and Docker Desktop bridge remain
accurate descriptions of the current implementation. Production deployment
uses the Compose-managed topology; development may migrate to the
same Compose-managed topology after it has been verified.

## Consequences

- Operators manage all long-running Yuki services with one Compose stack. No
  additional host service is required.
- The supervisor container has powerful Docker access and is part of the
  trusted deployment boundary. Its socket is never forwarded to the worker,
  API, browser, or processor job.
- Production packaging, job-volume isolation, and release verification are
  required parts of the production deployment task.
- This decision supersedes ADR-0003 only where it specifies a host process for
  the future production supervisor. ADR-0003's narrow protocol and restricted
  processor rules still apply.
