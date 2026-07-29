# ADR-0006: S3 compatibility target

Status: accepted

## Context

Yuki requires one optional S3-compatible storage backend without coupling its
catalogue model or object keys to a cloud vendor. The backend must stream large
objects, use multipart upload, support byte ranges and private signed downloads,
and verify durable size and SHA-256 metadata before database publication.

Compatibility needs a reproducible automated target. Public-cloud credentials
must not be required by the repository test suite.

## Decision

MinIO is the automated S3 compatibility target. Contract tests run the same
`BlobStore` lifecycle against the local filesystem and a pinned MinIO service.
The S3 implementation uses the AWS SDK only as a protocol client and accepts an
explicit HTTP(S) endpoint, region, bucket, credentials, and path-style setting.
It does not call vendor-specific APIs.

S3 buckets remain private. Staging uses multipart upload with bounded
concurrency and abort cleanup. Commit verifies the staged stream's size and
SHA-256, server-side copies it to a collision-safe final key carrying immutable
SHA-256 metadata, verifies final object metadata, and only then removes the
staging object. Integrity scans stream and hash authoritative bytes rather than
trusting ETags, whose meaning differs for multipart objects.

The API and worker select one installation-wide backend at startup. Credentials
are supplied through deployment configuration, are never returned through the
settings API, and are excluded from exports. Signed download URLs have a
configured maximum lifetime; authenticated proxy routes remain available for
feature workflows.

## Consequences

- Local storage remains the zero-configuration default.
- MinIO provides deterministic CI and development coverage without becoming a
  production dependency.
- Other S3-compatible providers can be configured, but release certification
  beyond MinIO is an explicit future compatibility claim.
- S3 commit and integrity verification read staged or committed bytes to avoid
  treating multipart ETags as content hashes. This favors correctness over
  minimum object-store traffic.
- Switching an existing installation's backend does not migrate objects.
  Backup/restore or a future migration workflow must move referenced data.
