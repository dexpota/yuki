# ADR-0002: Model export portability v1

## Status

Accepted for the MVP.

## Decision

A model export is a deterministic ZIP32 archive. `manifest.json` is the first member and conforms to `yuki-export-manifest-v1.schema.json`. Original asset bytes follow under `assets/<version-id>/<asset-id>`. Entries are stored without recompression, use UTF-8 paths, and are emitted as streams with data descriptors. Stable ordering is manifest, versions by creation time/id, and assets by version/id.

The manifest carries portable identifiers only. It never carries an owner ID, database storage-object ID/key, backend name, authentication/session state, printer endpoint or credential, encryption key, staging path, or job payload. Re-import allocates fresh database and storage identifiers while preserving the relationships represented by manifest identifiers.

Re-import accepts the deliberately narrow ZIP dialect emitted by Yuki. It rejects unsafe or duplicate paths, compression/encryption and other unsupported flags, undeclared or missing members, unknown manifest fields/versions, configured count/size limits, invalid timestamps/types, broken references, and mismatched SHA-256 or byte sizes. All members are staged and all relationships validated before one publication transaction. Failed validation publishes no catalogue rows; staged and committed orphan candidates are cleaned up best-effort.

HTTP requests only enqueue durable `catalogue.portability.export` or `catalogue.portability.import` jobs. Upload requests stream the package into managed storage before enqueueing. Authenticated status and download endpoints expose operation state and portable bytes, never an internal object key. A claimed worker performs the ZIP work and can safely retry: export completion is recorded before its job completes, while an import uses its operation UUID as the new model UUID so a post-commit retry recognizes the already-published model.

The `generatedArtifacts` and `printHistory` sections are required and empty in v1. Their owning persistence schemas have not been implemented, so inventing records would make round trips misleading. A later manifest version can define their record shapes once those features exist. Existing user images and documents are ordinary original assets and are included now.

## Consequences

- Packages are somewhat larger than compressed ZIPs, but export is bounded-memory and does not spend CPU recompressing already-compressed model files.
- The strict reader reduces parser attack surface and supports exact self-round-trips; it is not a general ZIP importer.
- Full-library database/file backup remains a separate operational workflow (O03), built on top of this portable per-model contract rather than replacing it.
