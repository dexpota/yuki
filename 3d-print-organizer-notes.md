# 3D Print Organizer — Product Notes

## Product concept

A web-based organizer for 3D-printable objects that combines model management, browser-based previews, slicing, and delivery to printers through OctoPrint.

The key product decision is whether it should primarily be:

- A personal library for files users already own
- A workflow tool covering discovery through printing
- A multi-user print-management platform

Trying to build all three immediately could make the first version too large.

## Suggested workflow

```text
Import model
    ↓
Extract metadata and generate preview
    ↓
Organize into projects, collections, and tags
    ↓
Select printer, material, and print profile
    ↓
Slice
    ↓
Inspect layers and estimated cost/time
    ↓
Send to OctoPrint and monitor
    ↓
Record the print result
```

## Potential features

### Library and organization

- Projects containing multiple related files and versions
- Tags, collections, favorites, and smart filters
- Full-text search
- Custom metadata: designer, source URL, license, material, and category
- Duplicate detection using file hashes or geometry
- Version tracking for modified models
- Attachments such as instructions, images, PDFs, and profile files
- Bulk imports from folders and archives
- Print history connected to each model

A **project** should be distinct from a **model**. A project might contain several STL or 3MF files, instructions, preview images, and multiple printable configurations.

### Importing

Potential sources include direct uploads, URLs, a browser extension, watched folders, and integrations with model-hosting sites.

Some sites expose APIs, while others prohibit scraping or require authentication. Every import should preserve:

- Original source URL
- Creator attribution
- License
- Original filename and archive
- Import date
- Remote model and version identifier

A browser extension or “save to organizer” bookmarklet may eventually be more reliable than server-side scraping.

### 3D preview

- STL, 3MF, OBJ, and possibly STEP support
- Orbit, pan, zoom, wireframe, and measurements
- Automatic thumbnail rendering
- Model dimensions and volume
- Mesh analysis: holes, non-manifold edges, and inverted normals
- Build-volume visualization
- Orientation controls
- Exploded view for multipart projects
- G-code layer preview after slicing

STL is common, but 3MF should be a first-class format because it can retain units, colors, multiple objects, and other metadata.

### Slicing

Possible slicing locations:

- On the application server
- In the user's browser or computer
- Through an external slicer service
- On the printer host

Server-side slicing using a slicer CLI is probably the simplest web experience, but printer and material profiles become a substantial domain of their own.

Useful slicing features include:

- One carefully chosen slicer engine initially, with optional additional engines later
- Printer, nozzle, filament, and quality profiles
- Per-model overrides
- Estimated time, weight, and material cost
- Profile snapshots so previous prints remain reproducible
- Clear separation between source models and generated G-code

### Printer integration

- Multiple printers
- Connection and availability status
- Upload-only and upload-and-start modes
- Queue management
- Webcam and progress monitoring
- Temperature and job status
- Cancellation and emergency controls
- Secure storage of OctoPrint API keys
- Compatibility checks before sending G-code
- Notifications when a job completes or fails

Starting printers remotely is safety-sensitive, so the application may need explicit confirmation and configurable permissions.

### Completed-print history

- Success, failure, or partial-success status
- Photos of finished prints
- Notes about adhesion, supports, tolerances, and defects
- Exact profile and filament used
- Printability ratings
- Reprint using the same configuration
- Comparison of attempts over time

Eventually, the application could recommend settings based on previous successful prints.

## Proposed MVP

1. Self-hosted, single-user application
2. Upload STL and 3MF files and ZIP projects
3. Import from public model URLs where permitted
4. Generate thumbnails and interactive 3D previews
5. Collections, tags, search, favorites, and source attribution
6. Store printer and material profiles
7. Slice through one selected slicer engine
8. Preview generated G-code
9. Upload to one or more OctoPrint instances
10. Store print history and notes

User accounts, collaboration, advanced queues, model repair, and numerous website-specific integrations can follow later.

## Suggested core domain model

Keep these four records separate:

1. **Project** — the overall downloadable or user-created object
2. **Model File** — an individual source file or part belonging to a project
3. **Print Configuration** — printer, material, slicing profile, orientation, and overrides
4. **Print Attempt** — generated G-code, dates, outcome, notes, and photographs

This separation prevents the library, slicing settings, generated G-code, and historical results from becoming tangled together.

## Technical considerations

- Maximum upload and archive size
- Whether original files are immutable
- Background jobs for previews, analysis, and slicing
- Isolation of untrusted model files and slicer processes
- Database and model-storage backups
- Support for local disks, network storage, and S3-compatible storage
- Behavior when a source model is updated or removed
- Offline operation

## Scope questions

### Product and audience

1. Is this primarily for personal use, a self-hosted open-source product, or a commercial hosted service?
  - Personal use, but if it could be adapted for commercial use it would be perfect;
2. Are the target users casual makers, print farms, professional designers, or a mixture?
  - Mixture;
3. Is multi-user collaboration required, or is single-user support enough initially?
  - Single user;
4. What is the single most important advantage over organizing files in folders and using an existing slicer?
  - Catalouge of everything printed;

### Model organization

5. What should be the main library unit: an individual model, a downloadable project, or a physical object composed of several parts?
  - Individual model is composed of multiple 3d files;
6. Should users be able to edit model files, or only organize, inspect, and print them?
  - No edits;
7. Is model and project version history required?
  - Yes;
8. Should metadata and tags be portable—for example, exportable with a project?
  - Yes, ideally everything should be exportable;

### Imports

9. Which websites must the first version support?
  - Thangs;
10. Should importing download the actual files, or initially store bookmarks and metadata?
  - Download;
11. Will users authenticate their accounts on those sites through the application?
  - Not at this time;
12. Should the application periodically check imported models for updates?
  - Nope;
13. Is a browser extension acceptable for sites without suitable APIs?
  - Nope;

### Formats and preview

14. Which formats are essential: STL, 3MF, OBJ, STEP, G-code, or others?
  - All of them;
15. Does the preview only need visualization, or also measurements, mesh diagnostics, orientation, and basic repair?
  - Let's start with a simple preview;
16. Is color and texture support required?
  - Not at this time;
17. Should users be able to arrange multiple parts on a virtual print bed?
  - No;

### Slicing

Avoid the slicing entirely.

18. Which slicer should be supported first?
19. Must slicing run on the server, or should users be able to connect a slicer installed on their computer?
20. Should users be able to import existing slicer profiles?
21. Are per-object settings, modifiers, support painting, and variable layer height required initially?
22. How important is exact reproduction of a previous print?

### Printers

23. Is OctoPrint the only printer interface for the first release?
  - Yes;
24. Are multiple printers and a print queue required?
  - Yes;
25. Should the application start jobs remotely, or only upload G-code?
  - Start the jobs remotely;
26. Are live monitoring, webcam support, notifications, and printer controls required?
  - Yes;
27. Should the system prevent G-code made for one printer from being sent to an incompatible printer?
  - Yes;

### Deployment and storage

28. Should installation use Docker Compose?
  - Yes;
29. Where should models live: application storage, an existing filesystem, NAS, or object storage?
  - It should support multiple storages (local, cloud);
30. Should the application support tens, thousands, or hundreds of thousands of models?
  - Thousands;
31. Must everything work locally without cloud services?
  - Yes;
32. Is mobile and tablet support important, particularly for monitoring prints?
  - No;
