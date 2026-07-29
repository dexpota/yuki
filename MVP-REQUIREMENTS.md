# 3D Print Organizer — MVP Requirements

## 1. Product definition

The MVP is a self-hosted, single-user web application for cataloguing 3D-printable models, keeping a history of printed objects, and managing print jobs across multiple OctoPrint printers.

Its primary value is a searchable catalogue of everything the user owns and has printed. It is not a model editor or slicer.

The initial product is intended for personal use, but its data model and architecture should not prevent later multi-user or commercial use.

## 2. MVP goals

The user must be able to:

1. Import a model manually from files or a ZIP archive.
2. Store all files and metadata belonging to the model.
3. Preview supported 3D files interactively in the browser.
4. Organize and search a library containing thousands of models.
5. Retain multiple versions of a model.
6. Export a model with all of its files and metadata.
7. Upload existing G-code to a compatible OctoPrint printer.
8. Queue, start, monitor, and control print jobs remotely.
9. Record what was printed and whether the print succeeded.
10. Operate entirely on the local network without mandatory cloud services.

## 3. Scope boundaries

### Included

- Single-user web application
- Model catalogue and print history
- Manual file and archive uploads
- STL, 3MF, OBJ, STEP, and G-code assets
- Simple interactive 3D previews
- Tags, collections, favorites, and search
- Model version history
- Full model and metadata export
- Multiple storage backends
- Multiple OctoPrint printers
- Application-managed print queue
- Remote job start and printer monitoring
- Desktop web interface
- Docker Compose installation

### Explicitly excluded

- Slicing and slicer profiles
- Editing or repairing 3D geometry
- Arranging parts on a virtual print bed
- Support painting, modifiers, or other slicer tools
- Color and texture rendering
- Direct imports from third-party model sites, including Thangs
- Automatic checks for upstream model updates
- Browser extensions or bookmarklets
- Multi-user accounts, roles, or collaboration
- Mobile-optimized and tablet-specific interfaces
- Mandatory cloud services
- Model recommendations or AI-generated print settings

## 4. Core concepts

### Model

The primary library item. A model represents one printable object or project and may contain multiple source files, G-code files, images, documents, and versions.

Required fields:

- Unique identifier
- Name
- Description
- Creation and update timestamps
- Import source: upload or Yuki export package
- Original source URL, when applicable
- Creator and license, when available
- Tags and collections
- Favorite status
- Current version
- Cover image or generated thumbnail

### Model version

An immutable snapshot of a model at a point in time.

It contains:

- Version number or label
- Creation timestamp
- Optional change note
- Files belonging to that version
- Metadata snapshot

Creating a new version must not overwrite or delete earlier versions.

### Asset

A file attached to a model version.

Asset types include:

- STL
- 3MF
- OBJ
- STEP
- G-code
- Image
- Document
- Other/original download

Each asset records its original filename, MIME type, size, checksum, storage location, and upload or import timestamp.

### Printer

An OctoPrint instance configured in the application.

It contains:

- Display name
- OctoPrint URL
- Encrypted API credential
- Connection status
- Printer/build-volume profile
- Supported G-code compatibility attributes
- Optional webcam configuration obtained from OctoPrint

### Print job

A request to print one G-code asset on one printer. It retains its queue state, relevant snapshots, progress, timestamps, and outcome.

### Print attempt

The historical result of a print job, linked to the model, exact model version, G-code asset, and printer.

It contains:

- Started and completed timestamps
- Outcome: successful, failed, cancelled, or unknown
- User notes
- Optional result photographs
- Available OctoPrint job statistics

## 5. Functional requirements

### 5.1 Model import

#### Local upload

- The user can upload individual supported files.
- The user can upload a ZIP archive containing multiple files.
- An archive import creates one model and attaches its supported contents as assets.
- The original uploaded file or archive is retained unchanged.
- The application computes a checksum for every stored asset.
- The application warns about exact duplicate files but allows the user to keep them.
- Import and preview generation run as background jobs and expose progress and failure states.

### 5.2 Catalogue management

- The user can create, view, update, and delete a model.
- Deleting a model requires confirmation and removes its managed assets according to the configured retention policy.
- The user can add and remove tags.
- The user can create collections and place a model in multiple collections.
- The user can mark models as favorites.
- The library supports pagination or incremental loading for thousands of models.
- The user can sort by name, import date, update date, last printed date, and print count.
- The user can filter by tag, collection, favorite status, file format, source, and whether the model has been printed.
- Search matches at least the model name, description, creator, tags, filenames, and source URL.

### 5.3 Version management

- The user can create a new version of an existing model by uploading one or more files.
- The user can view all versions and the files associated with each version.
- One version is designated as current.
- Historical print attempts remain linked to the exact version and G-code file used.
- Earlier versions can be downloaded or restored as the current version without being modified.

### 5.4 Preview

- STL, 3MF, OBJ, and STEP assets provide a simple interactive 3D view when they contain supported geometry.
- The view supports orbit, pan, zoom, reset-camera, and fit-to-object.
- The preview displays basic dimensions when they can be determined reliably.
- The preview does not provide mesh repair, measurements chosen by the user, editing, build-plate arrangement, colors, or textures.
- The application generates a thumbnail from previewable geometry for use in the library.
- G-code assets provide a read-only toolpath/layer preview when the file can be parsed safely; unsupported G-code remains downloadable and printable but is clearly marked as not previewable.
- A preview failure must not prevent the original asset from being stored or downloaded.

### 5.5 Export and portability

- The user can export a model as a ZIP archive.
- The export includes every model version, original assets, generated thumbnails, user-provided images and documents, print-history data, and machine-readable metadata.
- Metadata uses a documented, versioned JSON format.
- The exported package contains no OctoPrint API keys or other application secrets.
- The application can import its own export format without losing model metadata, versions, or asset relationships.
- A full-library backup and restore mechanism is required, covering the database and managed files.

### 5.6 Storage

- The default storage backend is a local filesystem volume.
- The storage abstraction must allow additional backends without changing the domain model.
- The MVP supports local filesystem storage and one S3-compatible object-storage backend.
- Cloud/object storage is optional; all core features work using local storage only.
- A model's assets may reside in a configured backend, but a single asset has one authoritative storage location.
- Credentials are stored securely and never included in exports or logs.
- The application detects inaccessible or missing assets and reports them without corrupting catalogue metadata.

### 5.7 OctoPrint printer management

- The user can configure multiple OctoPrint instances.
- The application verifies the connection and API credential when a printer is added.
- The printer list shows online/offline state, current operational state, and active job summary.
- API credentials are encrypted at rest and masked in the interface.
- Temporary connection failures do not delete or disable printer configuration.

### 5.8 G-code compatibility checks

Before a G-code asset can be queued or sent, the application must compare available G-code metadata with the selected printer profile.

At minimum, checks cover:

- Explicit target-printer metadata, when present
- Required build dimensions versus configured build volume, when they can be derived
- Firmware or flavor indicators, when present
- Nozzle diameter and extruder count, when present

If compatibility cannot be established, the application blocks the job by default and explains why. The user may explicitly override warnings, and the override is recorded in the print attempt. A known hard incompatibility cannot be overridden in the MVP.

### 5.9 Print queue and remote start

- Each printer has an ordered queue managed by the application.
- A queued job identifies one exact G-code asset and one target printer.
- The user can add, remove, and reorder jobs that have not started.
- The application uploads queued G-code to OctoPrint before starting it.
- Only one job per printer can be active.
- Starting a print requires an explicit confirmation that the printer is physically ready and safe to operate.
- Automatic unattended starting of the next queued job is excluded from the MVP.
- Queue state survives application restarts.
- The application reconciles its state with OctoPrint after a restart or temporary disconnection.

### 5.10 Monitoring and printer controls

For each connected printer, the application displays available OctoPrint data including:

- Job name
- Progress percentage
- Elapsed and estimated remaining time
- Printer state
- Tool and bed temperatures
- Webcam stream or snapshot

The user can:

- Start a confirmed queued job
- Pause and resume an active job
- Cancel an active job after confirmation
- Issue safe, supported temperature and basic printer controls exposed by OctoPrint

The application must clearly distinguish stale monitoring data from live data. Destructive or safety-relevant controls require confirmation.

### 5.11 Notifications

- The user can receive notifications when a print completes, fails, is cancelled, or the printer disconnects during a job.
- The MVP includes in-application notifications and one configurable external channel.
- Failure to deliver a notification does not change the underlying print-job state.

### 5.12 Print history

- Every job started through the application creates a print attempt automatically.
- The user can also record a historical or externally started print manually.
- Completed jobs remain linked to the exact model version, G-code asset, and printer.
- The user can set or correct the outcome and add notes and photographs.
- A model page displays print count, last-printed date, and its chronological attempt history.
- The catalogue can filter models that have never been printed or have failed attempts.

## 6. Primary user workflows

### Import and catalogue a model

1. The user uploads files or a ZIP archive.
2. The application imports the original files and user-supplied metadata.
3. Background processing generates thumbnails and previews.
4. The user reviews the model, adds tags, and assigns collections.
5. The model becomes searchable in the library.

### Print an existing G-code file

1. The user opens a model and selects a G-code asset.
2. The user selects a configured OctoPrint printer.
3. The application runs compatibility checks.
4. The user resolves errors or explicitly accepts overridable warnings.
5. The job is placed in that printer's queue.
6. When the printer is ready, the user confirms remote start.
7. The application uploads the file and starts the print through OctoPrint.
8. Progress, temperatures, and webcam data are shown.
9. On completion or termination, the application records the attempt and asks the user to confirm the outcome and optionally add notes or photos.

### Add a new model version

1. The user opens an existing model and chooses “Add version.”
2. The user supplies new files and an optional change note.
3. The application stores an immutable version and makes it current.
4. Previous versions and their print histories remain available.

### Export a model

1. The user selects a model and requests an export.
2. The application creates a ZIP containing all versions, assets, metadata, and print history.
3. The exported archive can be imported into another installation.

## 7. Non-functional requirements

### Deployment

- The application is distributed with Docker Compose.
- A new installation requires documented configuration but no external cloud account.
- Persistent database and file-storage volumes are explicitly configured.
- Upgrade and backup procedures are documented before the first stable release.

### Performance and scale

- The catalogue is designed and tested with at least 10,000 models and their associated metadata.
- A normal paginated library view should become usable within two seconds on a local network under the documented reference hardware.
- Uploads, imports, exports, thumbnail generation, and preview conversion do not block web requests.
- Large-file limits are configurable and failures are reported cleanly.

### Reliability

- Background jobs are retryable and idempotent where practical.
- Application restarts do not lose imports, queued print jobs, or recorded print state.
- Original source assets are never modified during preview generation.
- Database records and stored files can be backed up and restored consistently.

### Security and safety

- The MVP is single-user but still requires authentication unless explicitly configured for a trusted isolated network.
- State-changing requests are protected against cross-site request forgery and unauthorized remote access.
- Archives, geometry files, G-code parsing, and preview generation are treated as untrusted input.
- Archive extraction prevents path traversal and decompression bombs.
- File-processing workers run with restricted permissions and resource limits.
- Secrets are encrypted at rest and excluded from logs, exports, and backups unless the backup is explicitly encrypted.
- Remote print start, cancellation, and safety-relevant controls require clear confirmation.

### Browser and interface

- The MVP targets current desktop versions of major browsers.
- The interface remains functional at common laptop and desktop widths.
- Mobile-specific layouts and workflows are not acceptance requirements.

## 8. MVP release acceptance criteria

The MVP is complete when a user can, from a clean Docker Compose installation:

1. Sign in and configure local storage.
2. Import a multipart model from files or a ZIP archive.
3. View the model in the catalogue, tag it, search for it, and interact with its 3D preview.
4. Add a second immutable version and retrieve the first version unchanged.
5. Export the entire model and successfully re-import it with its relationships intact.
6. Configure at least two OctoPrint printers.
7. Upload a G-code asset and see a preview or an explicit unsupported-preview state.
8. Run compatibility checks and prevent sending a known incompatible file.
9. Queue jobs independently for both printers.
10. Confirm and remotely start a compatible job.
11. Monitor progress, temperatures, state, and webcam output when OctoPrint exposes them.
12. Pause, resume, and cancel a print with appropriate confirmations.
13. Receive completion or failure notification.
14. Record the outcome, notes, and a photograph in the model's print history.
15. Restart the application without losing models, versions, queues, or print history.
16. Use all core catalogue and OctoPrint features with no internet or cloud dependency, except for optional external notifications/storage.

## 9. Decisions still needed before implementation

These decisions do not change the product direction, but they should be resolved before implementation begins:

1. ~~The external notification channel for the MVP, such as email, Telegram, or
   a generic webhook.~~ Resolved as a generic HTTPS webhook by ADR-0007.
2. The exact S3-compatible provider used for integration testing.
3. The maximum default upload and ZIP extraction sizes.
4. ~~The supported STEP-to-preview conversion approach and its deployment/licensing constraints.~~ Resolved by ADR-0005.
5. The precise G-code metadata rules that qualify as a hard incompatibility versus an overridable warning.
6. The authentication behavior for trusted local-network installations.
7. Whether deletion immediately removes stored files or uses a recoverable retention period.
