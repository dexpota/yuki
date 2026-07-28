import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { ModelPrintHistory } from '../../printing/history/index.js';
import { useSession } from '../../settings/identity/session.js';
import {
  createCollection,
  deleteModel,
  getAssetPreviews,
  getModel,
  listCollections,
  type ModelDetail,
  replaceCollections,
  replaceTags,
  requestAssetPreviews,
  restoreVersion,
  updateModel,
} from '../api.js';
import { ModelPreview, type PreviewState } from '../preview/index.js';
import '../catalogue.css';

export function ModelPage() {
  const { modelId = '' } = useParams();
  const session = useSession();
  const csrfToken = session.data?.authenticated === true ? session.data.csrfToken : '';
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery({
    queryKey: ['catalogue', 'model', modelId],
    queryFn: () => getModel(modelId),
    enabled: modelId.length > 0,
  });

  const applyDetail = (result: ModelDetail) => {
    queryClient.setQueryData(['catalogue', 'model', modelId], result);
    void queryClient.invalidateQueries({ queryKey: ['catalogue', 'browse'] });
  };
  const favorite = useMutation({
    mutationFn: (value: boolean) => updateModel(modelId, { favorite: value }, csrfToken),
    onSuccess: applyDetail,
  });
  const remove = useMutation({
    mutationFn: () => deleteModel(modelId, csrfToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['catalogue', 'browse'] });
      void navigate('/');
    },
  });

  if (detail.isPending) return <DetailStatus message="Loading model…" busy />;
  if (detail.isError)
    return (
      <DetailStatus message="This model could not be loaded." retry={() => void detail.refetch()} />
    );

  const value = detail.data;
  return (
    <article className="model-detail">
      <Link className="catalogue-back" to="/">
        ← Catalogue
      </Link>
      <header className="model-detail-heading">
        <div>
          <p className="eyebrow">Model</p>
          <h1>{value.model.name}</h1>
          <p>{value.model.description || 'No description yet.'}</p>
        </div>
        <button
          className="favorite-button"
          type="button"
          disabled={favorite.isPending}
          aria-pressed={value.model.favorite}
          onClick={() => favorite.mutate(!value.model.favorite)}
        >
          {value.model.favorite ? '★ Favorite' : '☆ Add favorite'}
        </button>
      </header>
      <MutationError mutations={[favorite]} />

      <CurrentVersionPreviews detail={value} csrfToken={csrfToken} />
      <ModelPrintHistory
        csrfToken={csrfToken}
        context={{
          modelId: value.model.id,
          currentVersionId: value.model.current_version_id,
          printCount: value.model.print_count,
          lastPrintedAt: value.model.last_printed_at,
          versions: value.versions.map((version) => ({ id: version.id, label: version.label })),
          assets: value.assets.map((asset) => ({
            id: asset.id,
            modelVersionId: asset.model_version_id,
            filename: asset.original_filename,
            format: asset.format,
          })),
        }}
      />
      <div className="model-detail-columns">
        <div>
          <EditModel detail={value} csrfToken={csrfToken} onSuccess={applyDetail} />
          <TagsEditor detail={value} csrfToken={csrfToken} onSuccess={applyDetail} />
          <CollectionsEditor detail={value} csrfToken={csrfToken} onSuccess={applyDetail} />
        </div>
        <div>
          <VersionHistory detail={value} csrfToken={csrfToken} onSuccess={applyDetail} />
          <section className="catalogue-panel danger-panel">
            <h2>Delete model</h2>
            <p>Its managed assets will follow the configured retention policy.</p>
            <button
              className="danger-button"
              type="button"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete “${value.model.name}”? This cannot be undone.`))
                  remove.mutate();
              }}
            >
              {remove.isPending ? 'Deleting…' : 'Delete model'}
            </button>
            <MutationError mutations={[remove]} />
          </section>
        </div>
      </div>
    </article>
  );
}

function CurrentVersionPreviews({
  detail,
  csrfToken,
}: {
  readonly detail: ModelDetail;
  readonly csrfToken: string;
}) {
  const assets = detail.assets.filter(
    (asset) =>
      asset.model_version_id === detail.model.current_version_id &&
      ['stl', '3mf', 'obj', 'step', 'gcode'].includes(asset.format),
  );
  if (assets.length === 0) return null;
  return (
    <section className="catalogue-panel preview-panel">
      <h2>Previews</h2>
      <div className="asset-previews">
        {assets.map((asset) => (
          <AssetPreview key={asset.id} asset={asset} csrfToken={csrfToken} />
        ))}
      </div>
    </section>
  );
}

function AssetPreview({
  asset,
  csrfToken,
}: {
  readonly asset: ModelDetail['assets'][number];
  readonly csrfToken: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['catalogue', 'asset', asset.id, 'previews'] as const;
  const previews = useQuery({
    queryKey,
    queryFn: () => getAssetPreviews(asset.id),
    refetchInterval: (query) =>
      query.state.data?.artifacts.some(
        (artifact) => artifact.status === 'queued' || artifact.status === 'processing',
      )
        ? 1_000
        : false,
  });
  const request = useMutation({
    mutationFn: () => requestAssetPreviews(asset.id, csrfToken),
    onSuccess: (result) => queryClient.setQueryData(queryKey, result),
  });
  const artifact = previews.data?.artifacts.find((item) =>
    asset.format === 'gcode' ? item.kind === 'toolpath_preview' : item.kind === 'geometry_preview',
  );
  const state = artifact ? previewState(artifact) : undefined;

  return (
    <article className="asset-preview">
      <header>
        <div>
          <strong>{asset.original_filename}</strong>
          <small>{asset.format.toUpperCase()}</small>
        </div>
        {!previews.isPending && !artifact ? (
          <button type="button" disabled={request.isPending} onClick={() => request.mutate()}>
            {request.isPending ? 'Queuing…' : 'Generate preview'}
          </button>
        ) : null}
      </header>
      {previews.isPending ? <p aria-busy="true">Loading preview status…</p> : null}
      {previews.isError ? (
        <p role="alert">Preview status could not be loaded.</p>
      ) : state ? (
        <ModelPreview preview={state} />
      ) : null}
      <MutationError mutations={[request]} />
    </article>
  );
}

function previewState(
  artifact: Awaited<ReturnType<typeof getAssetPreviews>>['artifacts'][number],
): PreviewState {
  if (artifact.status === 'queued' || artifact.status === 'processing')
    return { status: artifact.status };
  if (artifact.status === 'failed' || artifact.status === 'unsupported')
    return {
      status: artifact.status,
      message: artifact.failure?.message ?? 'No additional details are available.',
    };
  if (!artifact.downloadUrl)
    return { status: 'failed', message: 'The generated artifact is unavailable.' };
  if (artifact.kind === 'toolpath_preview')
    return { status: 'ready', kind: 'toolpath', artifactUrl: artifact.downloadUrl };
  const dimensions = previewDimensions(artifact.dimensions);
  return {
    status: 'ready',
    kind: 'geometry',
    artifactUrl: artifact.downloadUrl,
    ...(dimensions ? { dimensions } : {}),
  };
}

function previewDimensions(
  value: unknown,
): { readonly width: number; readonly depth: number; readonly height: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const dimensions = value as Record<string, unknown>;
  return ['width', 'depth', 'height'].every(
    (name) => typeof dimensions[name] === 'number' && Number.isFinite(dimensions[name]),
  )
    ? {
        width: dimensions.width as number,
        depth: dimensions.depth as number,
        height: dimensions.height as number,
      }
    : undefined;
}

function EditModel({ detail, csrfToken, onSuccess }: EditorProps) {
  const model = detail.model;
  const [fields, setFields] = useState(() => modelFields(model));
  useEffect(() => setFields(modelFields(model)), [model]);
  const mutation = useMutation({
    mutationFn: () =>
      updateModel(
        model.id,
        {
          ...fields,
          creator: fields.creator || null,
          license: fields.license || null,
          sourceUrl: fields.sourceUrl || null,
          expectedUpdatedAt: model.updated_at,
        },
        csrfToken,
      ),
    onSuccess,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <section className="catalogue-panel">
      <h2>Details</h2>
      <form className="catalogue-form" onSubmit={submit}>
        <label>
          <span>Name</span>
          <input
            required
            value={fields.name}
            onChange={(event) => setFields({ ...fields, name: event.target.value })}
          />
        </label>
        <label>
          <span>Description</span>
          <textarea
            value={fields.description}
            onChange={(event) => setFields({ ...fields, description: event.target.value })}
          />
        </label>
        <div className="catalogue-form-pair">
          <label>
            <span>Creator</span>
            <input
              value={fields.creator}
              onChange={(event) => setFields({ ...fields, creator: event.target.value })}
            />
          </label>
          <label>
            <span>License</span>
            <input
              value={fields.license}
              onChange={(event) => setFields({ ...fields, license: event.target.value })}
            />
          </label>
        </div>
        <label>
          <span>Source URL</span>
          <input
            type="url"
            value={fields.sourceUrl}
            onChange={(event) => setFields({ ...fields, sourceUrl: event.target.value })}
          />
        </label>
        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save details'}
        </button>
        <MutationError mutations={[mutation]} />
      </form>
    </section>
  );
}

function TagsEditor({ detail, csrfToken, onSuccess }: EditorProps) {
  const [names, setNames] = useState(detail.tags.map((tag) => tag.name).join(', '));
  useEffect(() => setNames(detail.tags.map((tag) => tag.name).join(', ')), [detail.tags]);
  const mutation = useMutation({
    mutationFn: () =>
      replaceTags(
        detail.model.id,
        names
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
        csrfToken,
      ),
    onSuccess,
  });
  return (
    <section className="catalogue-panel">
      <h2>Tags</h2>
      <form
        className="catalogue-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          <span>Comma-separated tags</span>
          <input value={names} onChange={(event) => setNames(event.target.value)} />
        </label>
        <button type="submit" disabled={mutation.isPending}>
          Save tags
        </button>
        <MutationError mutations={[mutation]} />
      </form>
    </section>
  );
}

function CollectionsEditor({ detail, csrfToken, onSuccess }: EditorProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const collections = useQuery({
    queryKey: ['catalogue', 'collections'],
    queryFn: listCollections,
  });
  const replace = useMutation({
    mutationFn: (ids: readonly string[]) => replaceCollections(detail.model.id, ids, csrfToken),
    onSuccess,
  });
  const create = useMutation({
    mutationFn: async () => {
      const collection = await createCollection(name, description, csrfToken);
      return replaceCollections(
        detail.model.id,
        [...detail.collections.map((item) => item.id), collection.id],
        csrfToken,
      );
    },
    onSuccess: (result) => {
      setName('');
      setDescription('');
      onSuccess(result);
    },
  });
  return (
    <section className="catalogue-panel">
      <h2>Collections</h2>
      {detail.collections.length === 0 ? <p>This model is not in a collection.</p> : null}
      <ul className="chip-list">
        {detail.collections.map((collection) => (
          <li key={collection.id}>
            <span title={collection.description}>{collection.name}</span>
            <button
              type="button"
              aria-label={`Remove ${collection.name}`}
              disabled={replace.isPending}
              onClick={() =>
                replace.mutate(
                  detail.collections
                    .filter((item) => item.id !== collection.id)
                    .map((item) => item.id),
                )
              }
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form
        className="catalogue-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (selectedId)
            replace.mutate([...detail.collections.map((item) => item.id), selectedId]);
        }}
      >
        <label>
          <span>Add existing collection</span>
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            <option value="">Choose a collection</option>
            {(collections.data ?? [])
              .filter((collection) =>
                detail.collections.every((membership) => membership.id !== collection.id),
              )
              .map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
          </select>
        </label>
        <button type="submit" disabled={!selectedId || replace.isPending}>
          Add
        </button>
      </form>
      <form
        className="catalogue-form"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <label>
          <span>New collection</span>
          <input required value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>Description</span>
          <input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <button type="submit" disabled={create.isPending}>
          Create and add
        </button>
        <MutationError mutations={[create, replace]} />
      </form>
    </section>
  );
}

function VersionHistory({ detail, csrfToken, onSuccess }: EditorProps) {
  const mutation = useMutation({
    mutationFn: (versionId: string) => restoreVersion(detail.model.id, versionId, csrfToken),
    onSuccess,
  });
  return (
    <section className="catalogue-panel">
      <h2>Version history</h2>
      <ol className="version-list">
        {detail.versions.map((version) => {
          const current = version.id === detail.model.current_version_id;
          const assets = detail.assets.filter((asset) => asset.model_version_id === version.id);
          return (
            <li key={version.id}>
              <div>
                <strong>{version.label}</strong>
                {current ? <span className="current-version">Current</span> : null}
                <small>{formatDate(version.created_at)}</small>
              </div>
              {version.change_note ? <p>{version.change_note}</p> : null}
              {assets.length > 0 ? (
                <ul className="asset-list">
                  {assets.map((asset) => (
                    <li key={asset.id}>
                      {asset.original_filename} <small>{asset.format.toUpperCase()}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No files in this version.</p>
              )}
              {!current ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate(version.id)}
                >
                  Restore as current
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      <MutationError mutations={[mutation]} />
    </section>
  );
}

function MutationError({ mutations }: { readonly mutations: readonly { isError: boolean }[] }) {
  return mutations.some((mutation) => mutation.isError) ? (
    <p className="catalogue-error" role="alert">
      The change could not be saved. Refresh the model and try again.
    </p>
  ) : null;
}

function DetailStatus({
  message,
  busy = false,
  retry,
}: {
  readonly message: string;
  readonly busy?: boolean;
  readonly retry?: () => void;
}) {
  return (
    <section className="catalogue-status" aria-busy={busy} role={retry ? 'alert' : 'status'}>
      <p>{message}</p>
      {retry ? (
        <button type="button" onClick={retry}>
          Try again
        </button>
      ) : null}
    </section>
  );
}

type EditorProps = {
  readonly detail: ModelDetail;
  readonly csrfToken: string;
  readonly onSuccess: (result: ModelDetail) => void;
};

function modelFields(model: ModelDetail['model']) {
  return {
    name: model.name,
    description: model.description,
    creator: model.creator ?? '',
    license: model.license ?? '',
    sourceUrl: model.source_url ?? '',
  };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}
