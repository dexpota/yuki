# ADR-0004: G-code compatibility policy

Status: accepted

## Context

Yuki must compare bounded, parser-derived G-code facts with a versioned printer
profile before a file can be queued or sent. Missing or advisory slicer metadata
must not be treated as stronger evidence than derived motion bounds, and a rule
change must not reinterpret an existing print job or attempt.

The processor reports facts with evidence and explicit unknown reasons. Printer
profile version 1 records build volume shape, dimensions and origin, supported
G-code flavors, current nozzle diameter when configured, and extruder count.

## Decision

Compatibility rule set `1.0.0` evaluates five table-driven checks:

| Rule | Pass | Warning | Unknown | Hard incompatible |
| --- | --- | --- | --- | --- |
| Build volume | Derived bounds fit the configured rectangular or circular volume | — | — | Any derived X/Y/Z bound is outside the volume |
| Target printer | Explicit target matches printer ID or normalized display name | Explicit target names another printer | — | — |
| G-code flavor | Canonical flavor is in the printer's supported list | — | Fact is known but the printer list is empty | Known flavor is not supported |
| Nozzle diameter | Every declared diameter matches within 0.01 mm | Declared diameter differs | Fact is known but the printer nozzle is unconfigured | — |
| Extruder count | Required count does not exceed the configured count | — | — | Required count exceeds the configured count |

An absent G-code fact is `not_applicable`, because the requirement says to
compare these indicators when present. If every fact is absent, compatibility
cannot be established and the aggregate result is `unknown`.

Aggregate precedence is `incompatible`, `unknown`, `warning`, then
`compatible`. Every non-compatible result blocks by default. `warning` and
`unknown` may be explicitly overridden by later queue/start workflows;
`incompatible` cannot be overridden.

Flavor comparison is case- and separator-insensitive. `Marlin 2` and
`MarlinFirmware` canonicalize to `marlin`; `RepRapFirmware` canonicalizes to
`reprap`. New aliases or policy changes require a new rule-set version.

Circular build volumes require all four corners of the derived XY bounding box
to lie inside the configured radius. A `center` origin uses `(0, 0)`; a
`lowerleft` origin uses half the configured width and depth. Z always starts at
zero.

Each evaluation stores immutable copies of the validated G-code facts, asset
identity and checksum, printer identity and profile, rule-set version, every
check and explanation, aggregate status, and evaluation time. Historical rows
cannot be updated or deleted. Source ownership and type are validated when the
snapshot is inserted; snapshot rows deliberately do not foreign-key mutable
source records so later catalogue or printer deletion cannot erase audit data.

## Consequences

- Known geometric, firmware, and extruder conflicts are never overridable.
- Target and nozzle mismatches require deliberate operator confirmation because
  those metadata are advisory or may describe replaceable hardware.
- Missing optional metadata does not automatically make otherwise comparable
  G-code unknown, but files with no comparable facts remain blocked.
- Queue and print-attempt features can copy the complete evaluation snapshot
  without depending on mutable printer or catalogue presentation data.
