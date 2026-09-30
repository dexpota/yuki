# Filament presets for the print queue

Status: proposed

Tracking: [epic #9](https://github.com/dexpota/yuki/issues/9),
[preset API #10](https://github.com/dexpota/yuki/issues/10),
[queue and history #12](https://github.com/dexpota/yuki/issues/12),
[frontend #13](https://github.com/dexpota/yuki/issues/13), and
[acceptance #11](https://github.com/dexpota/yuki/issues/11).

## Summary

Yuki already has a durable, ordered queue for each printer. A queue entry identifies
an exact G-code asset and printer, survives restarts, records compatibility, and can
be started through the existing readiness-confirmation flow. It does not record the
filament the owner intends to use.

This feature adds reusable filament presets and assigns one preset to a queued print.
The assignment is visible in the queue and is copied into the immutable print-attempt
history when printing starts. Filament inventory, remaining weight, consumption,
cost accounting, and automatic stock deduction are explicitly excluded.

The initial preset is deliberately descriptive. Its versioned snapshot is the
extension point for future filament-specific print parameters without requiring Yuki
to become a slicer or reinterpret old print history.

## Goals

- Let the owner define a small reusable list such as `Prusament PLA — Galaxy Black`.
- Show what will be printed, on which printer, and with which filament in one queue
  row.
- Allow a job to be planned before its filament is known, but require an assignment
  before the job can start.
- Preserve the selected filament as an immutable print-attempt snapshot.
- Keep archived presets readable in queued jobs and history while excluding them
  from new assignments.
- Leave a compatible path for validated filament printing parameters in a later
  feature.

## Non-goals

- Physical spool inventory or spool identity.
- Remaining weight, usage estimates, cost, purchase history, or stock alerts.
- Automatic consumption based on G-code metadata.
- Slicing, slicer profiles, or generating G-code.
- Material compatibility rules in the first release.
- Mapping multiple filaments to individual extruders. Version 1 assigns one preset
  to the whole print job.

## User experience

### Preset management

Add a **Filament presets** section to printing settings. The owner can create, edit,
archive, and restore presets. A preset contains:

- Display name, required and chosen by the owner.
- Material, required free text with common suggestions such as PLA, PETG, ABS, ASA,
  TPU, and Nylon. Suggestions must not restrict uncommon materials.
- Color name, optional.
- Color value, optional six-digit RGB value used only as a visual aid.
- Manufacturer and product name, optional.
- Diameter in millimetres, optional and positive; common suggestions are 1.75 and
  2.85.
- Notes, optional plain text.

The display name remains the primary label. A color swatch is always accompanied by
the color name or RGB value and is never the only way information is conveyed.
Archiving is preferred to deletion so old queue and history records remain clear.

### Queue assignment

The existing add-to-queue form gains a filament selector after the G-code selector.
It defaults to **Choose later** so planning work is not blocked. Selecting a preset
captures a snapshot immediately.

Each queue row shows the model/G-code identity, filament display name, material,
optional color marker, compatibility state, and operational state. An unassigned row
shows the actionable warning **Filament not selected**. The owner can assign or
replace the preset while the entry is in `evaluating`, `blocked`, `queued`, or
`failed` state. Assignment changes use the queue entry version to reject stale
updates.

The start action remains visible for the queue head, but issuing its readiness
challenge fails with an actionable conflict if no filament is assigned. The final
confirmation identifies the filament alongside the printer and file so the owner can
physically verify the setup.

On narrow screens, filament details wrap below the file label rather than forcing a
wide table. Loading, empty, archived-selection, validation, stale-update, and server
error states use the existing printer-page patterns. Queue ordering and assignment
controls remain keyboard operable with visible focus.

### Print history

Remote print attempts display the immutable filament snapshot used at start. Manual
attempt creation may optionally select a preset and captures the same snapshot.
External attempts may leave filament unknown. Editing or archiving the live preset
never changes historical attempts.

## Domain model

### Live preset

`filament_presets` is owned by the printing feature:

```text
FilamentPreset
  id
  owner_id
  display_name
  material
  color_name?
  color_hex?
  manufacturer?
  product_name?
  diameter_mm?
  notes
  archived_at?
  created_at
  updated_at
  version
```

Names do not need to be unique. Two presets can deliberately describe similar
products. Text and numeric bounds are validated at both HTTP and database boundaries.
All reads and mutations are owner scoped.

### Immutable snapshot

Queue entries and print attempts store a validated snapshot rather than relying on a
mutable join for presentation:

```json
{
  "schemaVersion": 1,
  "presetId": "uuid",
  "capturedAt": "RFC 3339 timestamp",
  "displayName": "Prusament PLA — Galaxy Black",
  "material": "PLA",
  "colorName": "Galaxy Black",
  "colorHex": "1f2020",
  "manufacturer": "Prusa Polymers",
  "productName": "Prusament PLA",
  "diameterMm": 1.75,
  "notes": ""
}
```

`printing_queue_entries` gains nullable `filament_preset_id` and
`filament_snapshot` columns. Both are null or both are present. The foreign key uses
the owner boundary and does not cascade preset archival or deletion into the queue.
The snapshot may change only in pre-start states.

`print_attempts` gains nullable `filament_snapshot`. It is copied atomically from the
queue entry when a remote attempt is created and becomes part of the existing
immutable-history guard. It is nullable for attempts created before this migration
and for external attempts whose filament is unknown.

The next migration is additive and globally ordered. At the time of this design the
expected filename is `0022_filament_presets`, but implementation must re-check the
latest migration number before creating it.

## API design

All endpoints use the existing authenticated owner and CSRF boundaries.

```text
GET    /api/v1/printing/filament-presets?includeArchived=false
POST   /api/v1/printing/filament-presets
PATCH  /api/v1/printing/filament-presets/{presetId}
POST   /api/v1/printing/filament-presets/{presetId}/archive
POST   /api/v1/printing/filament-presets/{presetId}/restore

POST   /api/v1/printing/printers/{printerId}/queue
PATCH  /api/v1/printing/printers/{printerId}/queue/{entryId}/filament
```

The existing queue creation request accepts an optional `filamentPresetId`. Queue
responses add `filamentSnapshot`. The dedicated assignment request accepts
`filamentPresetId` and the expected queue-entry `version`; setting the ID to null
returns the entry to **Filament not selected**.

Preset updates use the preset `version` for optimistic concurrency. Archived presets
cannot be newly assigned, but an already captured snapshot remains valid. API
responses expose normalized public values only and never internal database fields.

Issuing a start challenge requires `filament_snapshot` and includes it in the
challenge payload. Accepting the challenge verifies that the queue entry has not
changed since issuance, then copies the exact challenged snapshot to the new print
attempt in the same transaction.

## Future printing parameters

A later design may associate validated parameters such as nozzle temperature, bed
temperature, cooling, maximum volumetric flow, or enclosure guidance with a filament
preset. That work must define units, bounds, printer/tool applicability, precedence,
and whether parameters are advisory or enforceable.

The future feature should introduce a new validated parameter schema and increment
the filament snapshot schema version. Existing version 1 snapshots remain readable
and are never backfilled or reinterpreted. Version 1 does not add an unvalidated
`parameters` JSON object, send settings to OctoPrint, or participate in compatibility
evaluation.

## Consistency and lifecycle rules

- Queue assignment and replacement lock the queue entry and validate owner-scoped,
  non-archived preset identity.
- Assignment is editable only before upload/start has begun.
- Start confirmation fails when no preset is assigned or when the challenged queue
  entry has since changed.
- Archiving a preset does not clear existing queue assignments. The queue shows that
  the selected preset is archived and lets the owner deliberately replace it.
- Presets referenced by queue entries are not hard-deleted.
- Print-attempt snapshots are immutable and portable with print history.
- Filament fields never affect the current G-code/printer compatibility result in
  this release.

## Portability and backup

Database backup and restore include the new table and columns automatically. Model
export remains model scoped: it includes filament snapshots attached to exported
print attempts, but not the owner's reusable preset library or live queue references.
Import preserves the snapshot as historical data and does not create or match a live
preset in the target installation. The export manifest schema and round-trip tests
must be updated accordingly.

## Verification

Backend tests must cover owner isolation, validation, optimistic concurrency,
archival/restoration, queue assignment state restrictions, start-without-filament
rejection, challenge staleness, atomic snapshot copying, history immutability, and
export/import round trips against PostgreSQL.

Frontend tests must cover preset CRUD states, free-text materials, accessible color
presentation, assignment at queue creation, reassignment, unassigned and archived
warnings, start blocking, confirmation content, responsive layout, and history
display.

Acceptance requires a clean installation to create a preset, queue G-code with it,
restart Yuki without losing the assignment, start the job through confirmation, edit
the live preset, and verify that the completed attempt still shows the original
snapshot.

## Delivery plan

1. Add filament preset persistence, validation, service, and authenticated API.
2. Integrate versioned snapshots with queue assignment, start confirmation, print
   attempts, history, and portable export.
3. Add preset management, queue selection/status, confirmation, and history UI.
4. Add PostgreSQL, frontend, portability, restart, and clean-install acceptance
   coverage before marking the feature complete.
