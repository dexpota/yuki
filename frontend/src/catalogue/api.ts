import { apiRequest } from '../shared/api/http.js';

export type AssetFormat =
  | 'stl'
  | '3mf'
  | 'obj'
  | 'step'
  | 'gcode'
  | 'image'
  | 'document'
  | 'archive'
  | 'other';

export type CatalogueSort = 'name' | 'importedAt' | 'updatedAt' | 'lastPrintedAt' | 'printCount';

export interface CatalogueItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly creator: string | null;
  readonly sourceUrl: string | null;
  readonly importSource: 'upload' | 'yuki_export';
  readonly favorite: boolean;
  readonly currentVersionId: string;
  readonly coverAssetId: string | null;
  readonly printCount: number;
  readonly lastPrintedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CataloguePageResult {
  readonly items: readonly CatalogueItem[];
  readonly nextCursor: string | null;
}

export interface CatalogueSearch {
  readonly query?: string | undefined;
  readonly tagId?: string | undefined;
  readonly collectionId?: string | undefined;
  readonly favorite?: boolean | undefined;
  readonly format?: AssetFormat | undefined;
  readonly source?: 'upload' | 'yuki_export' | undefined;
  readonly printed?: boolean | undefined;
  readonly sort: CatalogueSort;
  readonly direction: 'asc' | 'desc';
}

export interface ModelDetail {
  readonly model: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly import_source: 'upload' | 'yuki_export';
    readonly source_url: string | null;
    readonly creator: string | null;
    readonly license: string | null;
    readonly favorite: boolean;
    readonly current_version_id: string;
    readonly print_count: number;
    readonly last_printed_at: string | null;
    readonly created_at: string;
    readonly updated_at: string;
  };
  readonly versions: readonly ModelVersion[];
  readonly assets: readonly ModelAsset[];
  readonly tags: readonly Tag[];
  readonly collections: readonly Collection[];
}

export interface ModelVersion {
  readonly id: string;
  readonly model_id: string;
  readonly label: string;
  readonly change_note: string | null;
  readonly metadata_schema_version: number;
  readonly metadata_snapshot: unknown;
  readonly created_at: string;
  readonly published_at: string | null;
}

export interface ModelAsset {
  readonly id: string;
  readonly model_version_id: string;
  readonly role: string;
  readonly format: AssetFormat;
  readonly original_filename: string;
  readonly detected_mime_type: string;
  readonly byte_size: number | string;
  readonly checksum: string;
  readonly imported_at: string;
}

export interface Tag {
  readonly id: string;
  readonly name: string;
}

export interface Collection {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export type PreviewArtifactKind = 'geometry_preview' | 'thumbnail' | 'toolpath_preview';
export type PreviewArtifactStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'unsupported';

export interface PreviewArtifact {
  readonly id: string;
  readonly sourceAssetId: string;
  readonly kind: PreviewArtifactKind;
  readonly status: PreviewArtifactStatus;
  readonly mimeType: string | null;
  readonly byteSize: number | null;
  readonly dimensions: unknown | null;
  readonly summary: unknown | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly attempt: number;
  readonly downloadUrl: string | null;
}

export interface PreviewArtifactList {
  readonly artifacts: readonly PreviewArtifact[];
}

export function listTags(): Promise<readonly Tag[]> {
  return apiRequest('/api/v1/catalogue/tags');
}

export function listCollections(): Promise<readonly Collection[]> {
  return apiRequest('/api/v1/catalogue/collections');
}

export function searchCatalogue(
  search: CatalogueSearch,
  cursor?: string,
): Promise<CataloguePageResult> {
  const query = new URLSearchParams();
  set(query, 'q', search.query);
  set(query, 'tagId', search.tagId);
  set(query, 'collectionId', search.collectionId);
  set(query, 'favorite', search.favorite);
  set(query, 'format', search.format);
  set(query, 'source', search.source);
  set(query, 'printed', search.printed);
  query.set('sort', search.sort);
  query.set('direction', search.direction);
  query.set('limit', '24');
  set(query, 'cursor', cursor);
  return apiRequest<CataloguePageResult>(`/api/v1/catalogue/models?${query}`);
}

export function getModel(modelId: string): Promise<ModelDetail> {
  return apiRequest<ModelDetail>(modelPath(modelId));
}

export function getAssetPreviews(assetId: string): Promise<PreviewArtifactList> {
  return apiRequest<PreviewArtifactList>(previewPath(assetId));
}

export function requestAssetPreviews(
  assetId: string,
  csrfToken: string,
): Promise<PreviewArtifactList> {
  return apiRequest<PreviewArtifactList>(previewPath(assetId), {
    method: 'POST',
    csrfToken,
  });
}

export interface ModelUpdate {
  readonly name?: string;
  readonly description?: string;
  readonly creator?: string | null;
  readonly license?: string | null;
  readonly sourceUrl?: string | null;
  readonly favorite?: boolean;
  readonly expectedUpdatedAt?: string;
}

export function updateModel(
  modelId: string,
  update: ModelUpdate,
  csrfToken: string,
): Promise<ModelDetail> {
  return apiRequest<ModelDetail>(modelPath(modelId), {
    method: 'PATCH',
    body: JSON.stringify(update),
    csrfToken,
  });
}

export function replaceTags(
  modelId: string,
  names: readonly string[],
  csrfToken: string,
): Promise<ModelDetail> {
  return apiRequest<ModelDetail>(`${modelPath(modelId)}/tags`, {
    method: 'PUT',
    body: JSON.stringify({ names }),
    csrfToken,
  });
}

export function createCollection(
  name: string,
  description: string,
  csrfToken: string,
): Promise<Collection & { readonly created_at: string; readonly updated_at: string }> {
  return apiRequest('/api/v1/catalogue/collections', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
    csrfToken,
  });
}

export function replaceCollections(
  modelId: string,
  collectionIds: readonly string[],
  csrfToken: string,
): Promise<ModelDetail> {
  return apiRequest<ModelDetail>(`${modelPath(modelId)}/collections`, {
    method: 'PUT',
    body: JSON.stringify({ collectionIds }),
    csrfToken,
  });
}

export function restoreVersion(
  modelId: string,
  versionId: string,
  csrfToken: string,
): Promise<ModelDetail> {
  return apiRequest<ModelDetail>(`${modelPath(modelId)}/current-version`, {
    method: 'PUT',
    body: JSON.stringify({ versionId }),
    csrfToken,
  });
}

export function deleteModel(modelId: string, csrfToken: string): Promise<void> {
  return apiRequest<void>(modelPath(modelId), { method: 'DELETE', csrfToken });
}

function modelPath(modelId: string): string {
  return `/api/v1/catalogue/models/${encodeURIComponent(modelId)}`;
}

function previewPath(assetId: string): string {
  return `/api/v1/catalogue/assets/${encodeURIComponent(assetId)}/previews`;
}

function set(query: URLSearchParams, name: string, value: string | boolean | undefined): void {
  if (value !== undefined && value !== '') query.set(name, String(value));
}
