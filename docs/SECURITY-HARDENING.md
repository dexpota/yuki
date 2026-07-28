# Security hardening evidence

This note records the repeatable security checks for the MVP. It supplements the
threat boundaries in `ARCHITECTURE.md`; it does not replace them.

## Untrusted files

The processor test corpus covers malformed and truncated model/G-code inputs,
hostile numeric values, input/line/segment/triangle limits, and sanitized
failures. ZIP tests cover traversal, symbolic links, encrypted members,
duplicate and portable-name collisions, member and expanded-size limits,
compression ratios, malformed archives, and preservation of the original.

Run:

```sh
pnpm --filter @yuki/processor exec vitest run \
  test/archive/extract.test.ts \
  test/gcode/parse.test.ts \
  test/preview/generate.test.ts
```

## Network destinations and secrets

Printer URLs accept only HTTP(S), reject credentials, query strings, fragments,
loopback, link-local, multicast, carrier-grade NAT, and metadata destinations,
and optionally restrict hostnames and private networks. Every resolved address
must pass the policy, including IPv4-compatible or mapped IPv6 forms. OctoPrint
requests disable redirects and webcam URLs must remain same-origin.

Structured logs redact secret-bearing fields, authentication headers, sensitive
query parameters, and URL user-info. Unexpected upstream bodies and processor
errors are not reflected to clients or logs.

Run:

```sh
pnpm --filter @yuki/backend exec vitest run \
  test/printing/printers/gateway.test.ts \
  test/observability/logger.test.ts
```

## Browser mutations and physical actions

State-changing browser requests require both an allowed `Origin` and the
session-bound CSRF token. Remote starts and printer controls require short-lived
confirmation challenges bound to the owner and target state. Consumption is
single-use, idempotent only for the same request, and followed by fresh printer
state validation.

Run the HTTP tests without a database and the start/control service tests with a
disposable PostgreSQL database:

```sh
pnpm --filter @yuki/backend exec vitest run test/http/application.test.ts
YUKI_TEST_DATABASE_URL=postgresql://... pnpm --filter @yuki/backend exec vitest run \
  test/printing/start/service.test.ts \
  test/printing/controls/service.test.ts
```

## Container boundary

The backend, frontend, processor, and processor bridge run as non-root users.
Migration and application services drop all capabilities, prevent privilege
escalation, and use read-only root filesystems with narrow writable volumes or
temporary filesystems. Runtime commands invoke built Node entry points directly
and do not bootstrap a package manager. Application containers never receive
the Docker socket; the processor supervisor alone launches the fixed,
digest-pinned restricted processor operation.

Static deployment invariants are covered by
`backend/test/security/hardening.test.ts`. Before a release, build the three
images, inspect their configured users, run the processor container probes, and
validate the fully rendered Compose configuration.
