# Yuki full-backup format

## Purpose

O03 backups are operational, installation-wide backups. They are distinct from
portable per-model exports and are intended for clean-install disaster
recovery. The supported artifact is an uncompressed POSIX ustar stream with a
`.yuki-backup` suffix.

The archive entries are ordered:

1. `manifest.json`
2. `database.dump`
3. one entry per referenced local object, when the storage backend is `local`

The database entry is a PostgreSQL custom-format dump produced by `pg_dump`.
Local object entry paths split the opaque object key into ustar-safe components:
`blobs/<first-two>/<next-two>/<sha256>/<uuid>`. The manifest remains the
authority for the original opaque key.

## Manifest version 1

The UTF-8 JSON manifest has this shape:

```json
{
  "format": "yuki-full-backup",
  "version": 1,
  "createdAt": "2026-07-29T12:00:00.000Z",
  "database": {
    "path": "database.dump",
    "format": "postgresql-custom",
    "size": 1234,
    "sha256": "<lowercase SHA-256>",
    "migrations": ["0001_durable_jobs"]
  },
  "storage": {
    "backend": "local",
    "mode": "bundled"
  },
  "objects": [
    {
      "key": "objects/aa/bb/<sha256>-<uuid>",
      "size": 42,
      "sha256": "<lowercase SHA-256>"
    }
  ]
}
```

Objects are unique and sorted by key. Only committed objects with a positive
reference count are retained. Unreferenced objects already eligible for
retention cleanup are deliberately omitted.

For local storage, `mode` is `bundled` and every inventory item must have an
archive entry. For S3 storage, `mode` is `referenced`: the backup records and
verifies every live object but does not copy the S3 bytes. An S3 restore
therefore requires the configured bucket and inventoried objects to still be
available. Back up or replicate that bucket using the object-store operator's
own durability controls.

## Integrity and secrets

The reader accepts only regular-file ustar entries, bounded counts and sizes,
safe paths, valid header checksums, the declared entry order, and exact SHA-256
and byte-size matches. Restore refuses a storage-backend mismatch, a non-empty
local object store, or a database with existing public relations.

The artifact does not contain `YUKI_MASTER_KEY`, `YUKI_CSRF_KEY`, S3
credentials, or deployment environment files. The PostgreSQL dump still
contains password hashes, encrypted destination credentials, catalogue
metadata, and print history, so the artifact itself is sensitive and should be
stored with owner-only permissions and encrypted by the backup destination.

The installation master key must be backed up separately in a password manager,
hardware-backed secret store, or offline encrypted secret archive. Restore the
exact same key through deployment secrets before starting the API or worker;
without it, previously encrypted printer and webhook credentials cannot be
decrypted.
