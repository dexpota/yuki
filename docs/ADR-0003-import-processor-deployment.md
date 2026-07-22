# ADR-0003: Import processor deployment boundary

Status: accepted for the MVP implementation; runtime adapter still required

## Context

Local imports must pass untrusted files through the restricted processor. The existing processor runner starts a short-lived, digest-pinned container with no network, a read-only root filesystem, dropped capabilities, bounded resources, and narrowly scoped input/output mounts.

The Compose worker is itself a container. Giving it the Docker socket or a privileged container runtime would let a parser compromise become host control and would invalidate the isolation boundary. Paths inside the worker also cannot safely be passed as host bind-mount paths to the Docker daemon.

## Decision

The importing feature depends on the injected `ImportContentProcessor` contract. The feature owns durable staging, owner-scoped duplicate decisions, restart recovery, reports, and atomic catalogue publication. A deployment adapter owns materializing an immutable input in a private workspace, invoking `detect-file`, inspecting a ZIP before `extract-zip`, detecting each accepted member, and returning fresh member streams to the feature.

For the MVP deployment, that adapter must run in a host-side supervisor or an equivalently isolated job-runtime service with a narrow authenticated protocol. It alone may access the container runtime. API and general worker containers must not receive the Docker socket, broad host mounts, network access to an unrestricted Docker API, or additional Linux capabilities.

The adapter must preserve the processor runner restrictions and delete its private workspace after each attempt. Requests and results use stable session/file keys so a retry can compare output with already-persisted report rows.

## Consequences

- The feature implementation can be tested with a deterministic injected boundary and does not depend on container-runtime details.
- Current Compose composition must not enable the M07 pipeline until the supervisor adapter exists. Omitting the injected pipeline retains the pre-M07 single-file publication path for development compatibility; it is not considered secure processor wiring.
- M06 may expose persisted reports and the explicit duplicate-keep action, but end-to-end archive import in Compose is blocked by the supervisor adapter and its coordinator composition.
- The supervisor is deliberately not a general command-execution service. It allowlists the versioned processor operations and fixed mount paths only.
