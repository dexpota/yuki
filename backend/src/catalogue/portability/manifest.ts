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
  /** Reserved until generated-artifact persistence is implemented. Must be empty in v1. */
  readonly generatedArtifacts: readonly never[];
  /** Reserved until print-history persistence is implemented. Must be empty in v1. */
  readonly printHistory: readonly never[];
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
  if (array(root.generatedArtifacts, 'generatedArtifacts').length !== 0)
    invalid('unsupported_generated_artifacts');
  if (array(root.printHistory, 'printHistory').length !== 0) invalid('unsupported_print_history');
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
  validateRelationships(parsedModel.currentVersionId, parsedModel.coverAssetId, versions, assets);
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
    generatedArtifacts: [],
    printHistory: [],
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

function validateRelationships(
  currentVersionId: string,
  coverAssetId: string | null,
  versions: readonly PortableVersionV1[],
  assets: readonly PortableAssetV1[],
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
