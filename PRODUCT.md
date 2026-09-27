# Yuki

<!-- impeccable:product-schema 1 -->

## Audience

Yuki is for an individual who designs, collects, or prints 3D-printable models
and runs their own 3D printers. The intended user is comfortable operating a
self-hosted Docker Compose application on a local network.

## Purpose

Yuki keeps a personal library of printable models and a reliable record of
what was printed. It brings source files, model versions, printer-ready G-code,
and print outcomes together so the owner can find a model and understand its
history later.

## Positioning

Yuki connects a model's files and immutable versions to OctoPrint jobs and their
outcomes in one self-hosted catalogue. It organizes and tracks the print
workflow; it is not a slicer or geometry editor.

## User goals

- Import model files or ZIP archives and keep their originals intact.
- Browse, search, filter, preview, and organize a large model library.
- Preserve versions and export a model with its files and metadata.
- Manage multiple OctoPrint printers, evaluate G-code compatibility, and queue
  or control jobs.
- Record print outcomes, notes, and photographs against the exact model
  version and printer.
- Run and back up the application locally without depending on a cloud
  service.

## Platform

web

## Operating context

- Yuki is used primarily from a desktop browser on the owner's local network.
- The owner installs and backs up Yuki with Docker Compose.
- Local filesystem storage is the default. S3-compatible storage and external
  notifications are optional.

## Product constraints

- The MVP is single-user and local-network oriented.
- Core features work without a mandatory cloud service.
- Yuki is a catalogue and print organizer; it does not slice, edit, repair, or
  arrange 3D geometry.
- Direct imports from third-party model sites, including Thangs, are outside
  the MVP.
- Treat uploaded files and configured printer endpoints as untrusted.
- Keep model versions and published assets immutable so history remains
  dependable.
- Printer credentials are encrypted, and safety-relevant printer actions
  require confirmation.

## Terminology

- **Model:** a printable object or project in the catalogue, with files,
  metadata, and versions.
- **Version:** an immutable snapshot of a model's metadata and files.
- **Asset:** a file attached to a model version, such as a mesh, G-code, image,
  or document.
- **Printer:** an OctoPrint instance configured in Yuki.
- **Print attempt:** the historical result of printing a particular G-code
  asset on a printer.

## Voice

Use direct, calm, practical language. Make operational state and consequences
clear, especially for imports, printer commands, and print history. Prefer
familiar 3D-printing terms and explain errors in terms the owner can act on.

## Evidence on hand

- The repository contains the application and its operational documentation.
- `docs/RELEASE-ACCEPTANCE.md` records the MVP release acceptance evidence.
- No customer testimonials, press coverage, or commercial claims are
  documented. Do not invent them.

## Product principles

- Keep the owner's catalogue and files under their control.
- Preserve original files and version-specific print history.
- Make printer actions and their consequences clear before execution.
- Keep cloud services optional for core use.
- Keep catalogue and print organization distinct from slicing and geometry
  editing.
