export const YUKI_EXPORT_FORMAT = 'yuki-model-export' as const;
export const YUKI_EXPORT_VERSION = 1 as const;

const checksumPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PortableAssetV1 {
  readonly id: string;
  readonly versionId: string;
  readonly path: string;
  readonly role: 'geometry' | 'gcode' | 'image' | 'document' | 'other' | 'original_archive';
  readonly format:
    | 'stl'
    | '3mf'
    | 'obj'
    | 'step'
    | 'gcode'
    | 'image'
    | 'document'
    | 'archive'
    | 'other';
  readonly originalFilename: string;
  readonly detectedMimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly importedAt: string;
}

export interface PortableVersionV1 {
  readonly id: string;
  readonly label: string;
  readonly changeNote: string | null;
  readonly metadataSchemaVersion: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly assetIds: readonly string[];
}

export interface PortableGeneratedArtifactV1 {
  readonly id: string;
  readonly sourceAssetId: string;
  readonly path: string;
  readonly kind: 'geometry_preview' | 'thumbnail' | 'toolpath_preview';
  readonly generator: string;
  readonly generatorVersion: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly dimensions: Readonly<Record<string, unknown>> | null;
  readonly summary: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
  readonly completedAt: string;
}

export interface PortablePrintPhotoV1 {
  readonly id: string;
  readonly path: string;
  readonly originalFilename: string;
  readonly detectedMimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly byteSize: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface PortablePrintAttemptV1 {
  readonly id: string;
  readonly source: 'remote' | 'manual' | 'external';
  readonly modelVersionId: string | null;
  readonly assetId: string | null;
  readonly state:
    | 'starting'
    | 'printing'
    | 'paused'
    | 'reconciliation_required'
    | 'completed'
    | 'failed'
    | 'cancelled';
  readonly outcome: 'successful' | 'failed' | 'cancelled' | 'unknown' | null;
  readonly printerSnapshot: Readonly<Record<string, unknown>>;
  readonly modelSnapshot: Readonly<Record<string, unknown>>;
  readonly assetSnapshot: Readonly<Record<string, unknown>>;
  readonly compatibilitySnapshot: Readonly<Record<string, unknown>>;
  readonly overrideJustification: string | null;
  readonly notes: string;
  readonly statistics: Readonly<Record<string, unknown>>;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly events: readonly {
    readonly kind:
      | 'created'
      | 'printing'
      | 'paused'
      | 'resumed'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'reconciliation_required'
      | 'observation';
    readonly facts: Readonly<Record<string, unknown>>;
    readonly recordedAt: string;
  }[];
  readonly outcomeCorrections: readonly {
    readonly previousOutcome: 'successful' | 'failed' | 'cancelled' | 'unknown' | null;
    readonly outcome: 'successful' | 'failed' | 'cancelled' | 'unknown';
    readonly reason: string;
    readonly correctedAt: string;
  }[];
  readonly noteRevisions: readonly {
    readonly notes: string;
    readonly createdAt: string;
  }[];
  readonly photos: readonly PortablePrintPhotoV1[];
}

export interface YukiExportManifestV1 {
  readonly format: typeof YUKI_EXPORT_FORMAT;
  readonly version: typeof YUKI_EXPORT_VERSION;
  readonly model: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly sourceUrl: string | null;
    readonly creator: string | null;
    readonly license: string | null;
    readonly favorite: boolean;
    readonly currentVersionId: string;
    readonly coverAssetId: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly versions: readonly PortableVersionV1[];
  readonly assets: readonly PortableAssetV1[];
  readonly tags: readonly string[];
  readonly collections: readonly { readonly name: string; readonly description: string }[];
  readonly generatedArtifacts: readonly PortableGeneratedArtifactV1[];
  readonly printHistory: readonly PortablePrintAttemptV1[];
}

export class InvalidPortablePackageError extends Error {
  override readonly name = 'InvalidPortablePackageError';
  public constructor(
    public readonly reason: string,
    message = 'The export package is invalid',
  ) {
    super(message);
  }
}

export function parseManifestV1(value: unknown): YukiExportManifestV1 {
  const root = record(value, 'manifest');
  exactKeys(root, [
    'format',
    'version',
    'model',
    'versions',
    'assets',
    'tags',
    'collections',
    'generatedArtifacts',
    'printHistory',
  ]);
  if (root.format !== YUKI_EXPORT_FORMAT || root.version !== YUKI_EXPORT_VERSION)
    invalid('unsupported_version');
  const model = record(root.model, 'model');
  exactKeys(model, [
    'id',
    'name',
    'description',
    'sourceUrl',
    'creator',
    'license',
    'favorite',
    'currentVersionId',
    'coverAssetId',
    'createdAt',
    'updatedAt',
  ]);
  const versions = array(root.versions, 'versions').map(parseVersion);
  const assets = array(root.assets, 'assets').map(parseAsset);
  const tags = array(root.tags, 'tags').map((tag) => text(tag, 100));
  const collections = array(root.collections, 'collections').map((entry) => {
    const item = record(entry, 'collection');
    exactKeys(item, ['name', 'description']);
    return { name: text(item.name, 200), description: text(item.description, 20_000, true) };
  });
  const generatedArtifacts = array(root.generatedArtifacts, 'generatedArtifacts').map(
    parseGeneratedArtifact,
  );
  const printHistory = array(root.printHistory, 'printHistory').map(parsePrintAttempt);
  const parsedModel = {
    id: id(model.id),
    name: text(model.name, 300),
    description: text(model.description, 100_000, true),
    sourceUrl: nullableText(model.sourceUrl, 4096),
    creator: nullableText(model.creator, 1000),
    license: nullableText(model.license, 1000),
    favorite: boolean(model.favorite),
    currentVersionId: id(model.currentVersionId),
    coverAssetId: nullableId(model.coverAssetId),
    createdAt: timestamp(model.createdAt),
    updatedAt: timestamp(model.updatedAt),
  };
  validateRelationships(
    parsedModel.currentVersionId,
    parsedModel.coverAssetId,
    versions,
    assets,
    generatedArtifacts,
    printHistory,
  );
  return {
    format: YUKI_EXPORT_FORMAT,
    version: YUKI_EXPORT_VERSION,
    model: parsedModel,
    versions,
    assets,
    tags: uniqueBy(tags, (tag) => tag.trim().toLowerCase(), 'duplicate_tag'),
    collections: uniqueBy(
      collections,
      (item) => item.name.trim().toLowerCase(),
      'duplicate_collection',
    ),
    generatedArtifacts,
    printHistory,
  };
}

export function canonicalManifestJson(manifest: YukiExportManifestV1): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function parseVersion(value: unknown): PortableVersionV1 {
  const item = record(value, 'version');
  exactKeys(item, [
    'id',
    'label',
    'changeNote',
    'metadataSchemaVersion',
    'metadata',
    'createdAt',
    'assetIds',
  ]);
  return {
    id: id(item.id),
    label: text(item.label, 100),
    changeNote: nullableText(item.changeNote, 20_000),
    metadataSchemaVersion: integer(item.metadataSchemaVersion, 1, 1_000),
    metadata: record(item.metadata, 'metadata'),
    createdAt: timestamp(item.createdAt),
    assetIds: array(item.assetIds, 'assetIds').map(id),
  };
}

function parseAsset(value: unknown): PortableAssetV1 {
  const item = record(value, 'asset');
  exactKeys(item, [
    'id',
    'versionId',
    'path',
    'role',
    'format',
    'originalFilename',
    'detectedMimeType',
    'byteSize',
    'sha256',
    'importedAt',
  ]);
  const path = text(item.path, 2048);
  if (!/^assets\/[0-9a-f-]{36}\/[^/]+$/i.test(path) || path.includes('..') || path.includes('\\'))
    invalid('unsafe_asset_path');
  const role = enumValue(item.role, [
    'geometry',
    'gcode',
    'image',
    'document',
    'other',
    'original_archive',
  ] as const);
  const format = enumValue(item.format, [
    'stl',
    '3mf',
    'obj',
    'step',
    'gcode',
    'image',
    'document',
    'archive',
    'other',
  ] as const);
  const sha256 = text(item.sha256, 64);
  if (!checksumPattern.test(sha256)) invalid('invalid_checksum');
  const assetId = id(item.id);
  const versionId = id(item.versionId);
  if (path !== `assets/${versionId}/${assetId}`) invalid('invalid_asset_path');
  return {
    id: assetId,
    versionId,
    path,
    role,
    format,
    originalFilename: text(item.originalFilename, 1024),
    detectedMimeType: text(item.detectedMimeType, 255),
    byteSize: integer(item.byteSize, 0, Number.MAX_SAFE_INTEGER),
    sha256,
    importedAt: timestamp(item.importedAt),
  };
}

function parseGeneratedArtifact(value: unknown): PortableGeneratedArtifactV1 {
  const item = record(value, 'generated_artifact');
  exactKeys(item, [
    'id',
    'sourceAssetId',
    'path',
    'kind',
    'generator',
    'generatorVersion',
    'mimeType',
    'byteSize',
    'sha256',
    'dimensions',
    'summary',
    'createdAt',
    'completedAt',
  ]);
  const artifactId = id(item.id);
  const sourceAssetId = id(item.sourceAssetId);
  const path = portablePath(item.path, `generated/${sourceAssetId}/${artifactId}`);
  return {
    id: artifactId,
    sourceAssetId,
    path,
    kind: enumValue(item.kind, ['geometry_preview', 'thumbnail', 'toolpath_preview'] as const),
    generator: text(item.generator, 100),
    generatorVersion: text(item.generatorVersion, 100),
    mimeType: text(item.mimeType, 255),
    byteSize: integer(item.byteSize, 0, Number.MAX_SAFE_INTEGER),
    sha256: checksum(item.sha256),
    dimensions: nullableRecord(item.dimensions, 'dimensions'),
    summary: nullableRecord(item.summary, 'summary'),
    createdAt: timestamp(item.createdAt),
    completedAt: timestamp(item.completedAt),
  };
}

function parsePrintAttempt(value: unknown): PortablePrintAttemptV1 {
  const item = record(value, 'print_attempt');
  exactKeys(item, [
    'id',
    'source',
    'modelVersionId',
    'assetId',
    'state',
    'outcome',
    'printerSnapshot',
    'modelSnapshot',
    'assetSnapshot',
    'compatibilitySnapshot',
    'overrideJustification',
    'notes',
    'statistics',
    'startedAt',
    'completedAt',
    'createdAt',
    'updatedAt',
    'events',
    'outcomeCorrections',
    'noteRevisions',
    'photos',
  ]);
  const attemptId = id(item.id);
  const outcomes = ['successful', 'failed', 'cancelled', 'unknown'] as const;
  return {
    id: attemptId,
    source: enumValue(item.source, ['remote', 'manual', 'external'] as const),
    modelVersionId: nullableId(item.modelVersionId),
    assetId: nullableId(item.assetId),
    state: enumValue(item.state, [
      'starting',
      'printing',
      'paused',
      'reconciliation_required',
      'completed',
      'failed',
      'cancelled',
    ] as const),
    outcome: item.outcome === null ? null : enumValue(item.outcome, outcomes),
    printerSnapshot: record(item.printerSnapshot, 'printer_snapshot'),
    modelSnapshot: record(item.modelSnapshot, 'model_snapshot'),
    assetSnapshot: record(item.assetSnapshot, 'asset_snapshot'),
    compatibilitySnapshot: record(item.compatibilitySnapshot, 'compatibility_snapshot'),
    overrideJustification: nullableText(item.overrideJustification, 10_000),
    notes: text(item.notes, 10_000, true),
    statistics: record(item.statistics, 'statistics'),
    startedAt: nullableTimestamp(item.startedAt),
    completedAt: nullableTimestamp(item.completedAt),
    createdAt: timestamp(item.createdAt),
    updatedAt: timestamp(item.updatedAt),
    events: array(item.events, 'events').map((value) => {
      const event = record(value, 'event');
      exactKeys(event, ['kind', 'facts', 'recordedAt']);
      return {
        kind: enumValue(event.kind, [
          'created',
          'printing',
          'paused',
          'resumed',
          'completed',
          'failed',
          'cancelled',
          'reconciliation_required',
          'observation',
        ] as const),
        facts: record(event.facts, 'event_facts'),
        recordedAt: timestamp(event.recordedAt),
      };
    }),
    outcomeCorrections: array(item.outcomeCorrections, 'outcomeCorrections').map((value) => {
      const correction = record(value, 'outcome_correction');
      exactKeys(correction, ['previousOutcome', 'outcome', 'reason', 'correctedAt']);
      return {
        previousOutcome:
          correction.previousOutcome === null
            ? null
            : enumValue(correction.previousOutcome, outcomes),
        outcome: enumValue(correction.outcome, outcomes),
        reason: text(correction.reason, 1000),
        correctedAt: timestamp(correction.correctedAt),
      };
    }),
    noteRevisions: array(item.noteRevisions, 'noteRevisions').map((value) => {
      const revision = record(value, 'note_revision');
      exactKeys(revision, ['notes', 'createdAt']);
      return {
        notes: text(revision.notes, 10_000, true),
        createdAt: timestamp(revision.createdAt),
      };
    }),
    photos: array(item.photos, 'photos').map((value) => parsePrintPhoto(value, attemptId)),
  };
}

function parsePrintPhoto(value: unknown, attemptId: string): PortablePrintPhotoV1 {
  const item = record(value, 'print_photo');
  exactKeys(item, [
    'id',
    'path',
    'originalFilename',
    'detectedMimeType',
    'byteSize',
    'sha256',
    'createdAt',
  ]);
  const photoId = id(item.id);
  return {
    id: photoId,
    path: portablePath(item.path, `history/${attemptId}/photos/${photoId}`),
    originalFilename: text(item.originalFilename, 1024),
    detectedMimeType: enumValue(item.detectedMimeType, [
      'image/jpeg',
      'image/png',
      'image/webp',
    ] as const),
    byteSize: integer(item.byteSize, 1, 26_214_400),
    sha256: checksum(item.sha256),
    createdAt: timestamp(item.createdAt),
  };
}

function validateRelationships(
  currentVersionId: string,
  coverAssetId: string | null,
  versions: readonly PortableVersionV1[],
  assets: readonly PortableAssetV1[],
  generatedArtifacts: readonly PortableGeneratedArtifactV1[],
  printHistory: readonly PortablePrintAttemptV1[],
): void {
  if (versions.length === 0 || assets.length === 0) invalid('empty_model');
  const versionIds = new Set(
    unique(
      versions.map((v) => v.id),
      'duplicate_version',
    ),
  );
  const assetIds = new Set(
    unique(
      assets.map((a) => a.id),
      'duplicate_asset',
    ),
  );
  if (!versionIds.has(currentVersionId)) invalid('invalid_current_version');
  if (coverAssetId !== null && !assetIds.has(coverAssetId)) invalid('invalid_cover_asset');
  const paths = new Set<string>();
  for (const asset of assets) {
    if (!versionIds.has(asset.versionId)) invalid('missing_asset_version');
    if (paths.has(asset.path)) invalid('duplicate_asset_path');
    paths.add(asset.path);
  }
  for (const version of versions) {
    if (version.assetIds.length === 0) invalid('empty_version');
    if (new Set(version.assetIds).size !== version.assetIds.length)
      invalid('duplicate_version_asset');
    for (const assetId of version.assetIds) {
      const asset = assets.find((candidate) => candidate.id === assetId);
      if (!asset || asset.versionId !== version.id) invalid('invalid_version_asset');
    }
  }
  if (
    assets.some(
      (asset) =>
        !versions.find((version) => version.id === asset.versionId)?.assetIds.includes(asset.id),
    )
  )
    invalid('unreferenced_asset');
  const allPaths = new Set(assets.map((asset) => asset.path));
  uniqueBy(generatedArtifacts, (artifact) => artifact.id, 'duplicate_generated_artifact');
  for (const artifact of generatedArtifacts) {
    if (!assetIds.has(artifact.sourceAssetId)) invalid('missing_artifact_asset');
    if (allPaths.has(artifact.path)) invalid('duplicate_payload_path');
    allPaths.add(artifact.path);
  }
  uniqueBy(printHistory, (attempt) => attempt.id, 'duplicate_print_attempt');
  uniqueBy(
    printHistory.flatMap((attempt) => attempt.photos),
    (photo) => photo.id,
    'duplicate_print_photo',
  );
  for (const attempt of printHistory) {
    if (attempt.modelVersionId !== null && !versionIds.has(attempt.modelVersionId))
      invalid('missing_print_version');
    if (attempt.assetId !== null && !assetIds.has(attempt.assetId)) invalid('missing_print_asset');
    if (
      attempt.modelVersionId !== null &&
      attempt.assetId !== null &&
      assets.find((asset) => asset.id === attempt.assetId)?.versionId !== attempt.modelVersionId
    )
      invalid('invalid_print_asset_version');
    if ((attempt.outcome === null) !== (attempt.completedAt === null))
      invalid('invalid_print_completion');
    if (attempt.state === 'printing' && attempt.startedAt === null) invalid('invalid_print_start');
    for (const photo of attempt.photos) {
      if (allPaths.has(photo.path)) invalid('duplicate_payload_path');
      allPaths.add(photo.path);
    }
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(`invalid_${label}`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`invalid_${label}`);
  return value;
}
function text(value: unknown, max: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && value.trim().length === 0) ||
    value.includes('\u0000')
  )
    invalid('invalid_text');
  return value;
}
function nullableText(value: unknown, max: number): string | null {
  return value === null ? null : text(value, max, true);
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid('invalid_boolean');
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    invalid('invalid_integer');
  return value as number;
}
function id(value: unknown): string {
  const result = text(value, 36);
  if (!idPattern.test(result)) invalid('invalid_id');
  return result;
}
function nullableId(value: unknown): string | null {
  return value === null ? null : id(value);
}
function timestamp(value: unknown): string {
  const result = text(value, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    invalid('invalid_timestamp');
  return result;
}
function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}
function nullableRecord(value: unknown, label: string): Readonly<Record<string, unknown>> | null {
  return value === null ? null : record(value, label);
}
function checksum(value: unknown): string {
  const result = text(value, 64);
  if (!checksumPattern.test(result)) invalid('invalid_checksum');
  return result;
}
function portablePath(value: unknown, expected: string): string {
  const result = text(value, 2048);
  if (result !== expected || result.includes('..') || result.includes('\\'))
    invalid('unsafe_payload_path');
  return result;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key)))
    invalid('unknown_field');
}
function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) invalid('invalid_enum');
  return value as T[number];
}
function unique<T>(values: readonly T[], reason: string): readonly T[] {
  if (new Set(values).size !== values.length) invalid(reason);
  return values;
}
function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  reason: string,
): readonly T[] {
  if (new Set(values.map(key)).size !== values.length) invalid(reason);
  return values;
}
function invalid(reason: string): never {
  throw new InvalidPortablePackageError(reason);
}
