# ADR-0005: STEP preview conversion

- Status: Accepted
- Date: 2026-07-28
- Task: C05

## Context

The MVP requires STEP assets with supported geometry to produce the same
bounded GLB preview representation as STL, OBJ, and 3MF assets. STEP parsing and
tessellation handle untrusted, structurally complex input and therefore remain
inside Yuki's restricted processor. The selected converter must work without
network access at runtime and have redistributable licensing compatible with
the self-hosted processor image.

## Decision

Yuki pins `occt-import-js` version `0.0.23` and invokes its Open CASCADE STEP
reader from the restricted processor. The WebAssembly module is initialized
lazily and tessellates to millimeter output with fixed deflection parameters.
Yuki validates the returned mesh arrays, reapplies its own triangle and output
limits, and emits only the existing position-only GLB, dimensions, and
thumbnail artifacts. The converter never receives a host path or network
access.

`occt-import-js` and its bundled Open CASCADE build are LGPL-2.1 licensed.
Their license texts are retained by the package and copied to `/licenses` in
the processor image. The package is used unmodified. Corresponding source and
build instructions are available from:

- <https://github.com/kovacsv/occt-import-js/tree/0.0.23>
- the Open CASCADE submodule commit recorded by that tag

Replacing or upgrading this dependency requires a new malformed-file,
licensing, image-size, and generated-output review. The package and processor
image remain pinned through `pnpm-lock.yaml` and the normal image-digest
deployment boundary.

## Consequences

- STEP conversion works locally and offline after the image is built.
- The runtime image grows by approximately 11 MB unpacked.
- Operators redistributing the processor image must preserve `/licenses` and
  the source/build notice above.
- Conversion failures and limit violations remain isolated preview failures;
  the original STEP asset is retained unchanged and remains downloadable.

## Alternatives considered

- A host-installed Open CASCADE CLI was rejected because it would make native
  deployments and Docker Desktop use different conversion boundaries.
- FreeCAD headless conversion was rejected because its substantially larger
  runtime and plugin surface are unnecessary for the MVP.
- Deferring STEP preview was rejected because STEP interactive previews are an
  explicit MVP requirement and an unresolved release decision.
