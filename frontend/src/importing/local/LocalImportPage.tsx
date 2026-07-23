import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type DragEvent, type FormEvent, useRef, useState } from 'react';
import { Link } from 'react-router';

import { ApiError } from '../../shared/api/http.js';
import {
  getLocalImport,
  importWarnings,
  keepExactDuplicates,
  type LocalImportSession,
  uploadLocalImport,
} from './api.js';
import './local-import.css';

export function LocalImportPage({ csrfToken }: { readonly csrfToken: string }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [modelName, setModelName] = useState('');
  const [modelNameEdited, setModelNameEdited] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const cancellation = useRef<AbortController | null>(null);
  const lastUpload = useRef<{ readonly signature: string; readonly idempotencyKey: string } | null>(
    null,
  );
  const sessionKey = ['imports', 'local', sessionId] as const;
  const session = useQuery({
    queryKey: sessionKey,
    queryFn: () => getLocalImport(requiredSessionId(sessionId)),
    enabled: sessionId !== null,
    refetchInterval: (query) => (shouldPoll(query.state.data) ? 1_000 : false),
  });
  const upload = useMutation({
    mutationFn: async () => {
      if (!file || !modelName.trim()) throw new TypeError('Choose a file and enter a model name.');
      const controller = new AbortController();
      cancellation.current = controller;
      setUploadProgress(0);
      const signature = [file.name, file.size, file.lastModified, modelName.trim()].join('\u0000');
      if (lastUpload.current?.signature !== signature)
        lastUpload.current = { signature, idempotencyKey: crypto.randomUUID() };
      try {
        return await uploadLocalImport({
          file,
          modelName,
          csrfToken,
          idempotencyKey: lastUpload.current.idempotencyKey,
          signal: controller.signal,
          onProgress: (uploaded, total) =>
            setUploadProgress(total > 0 ? Math.min(100, Math.round((uploaded / total) * 100)) : 0),
        });
      } finally {
        cancellation.current = null;
      }
    },
    onSuccess: (created) => {
      setSessionId(created.id);
      queryClient.setQueryData(['imports', 'local', created.id], created);
      void queryClient.invalidateQueries({ queryKey: ['catalogue', 'browse'] });
    },
  });
  const duplicateFiles =
    session.data?.files?.filter((item) => item.duplicateDecision === 'required') ?? [];
  const duplicates = useMutation({
    mutationFn: () =>
      keepExactDuplicates(
        requiredSessionId(sessionId),
        duplicateFiles.map((item) => item.id),
        csrfToken,
      ),
    onSuccess: async () => {
      await session.refetch();
    },
  });

  const chooseFile = (next: File) => {
    setFile(next);
    setSessionId(null);
    setUploadProgress(0);
    lastUpload.current = null;
    upload.reset();
    duplicates.reset();
    if (!modelNameEdited || !modelName.trim()) setModelName(nameFrom(next.name));
  };
  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const next = event.dataTransfer.files[0];
    if (next) chooseFile(next);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    upload.mutate();
  };
  const startAnother = () => {
    setFile(null);
    setModelName('');
    setModelNameEdited(false);
    setSessionId(null);
    setUploadProgress(0);
    lastUpload.current = null;
    upload.reset();
    duplicates.reset();
  };

  return (
    <section className="local-import-page">
      <header className="local-import-heading">
        <div>
          <p className="eyebrow">Manual import</p>
          <h1>Add a model</h1>
          <p>Upload a model file or ZIP archive. Original bytes are always retained.</p>
        </div>
        <Link to="/">Return to catalogue</Link>
      </header>

      <form className="local-import-form" onSubmit={submit}>
        <label
          className={`import-drop-zone${dragging ? ' is-dragging' : ''}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <input
            type="file"
            accept=".stl,.3mf,.obj,.step,.stp,.gcode,.zip"
            disabled={upload.isPending}
            onChange={(event) => {
              const next = event.target.files?.[0];
              if (next) chooseFile(next);
            }}
          />
          <span className="import-drop-title">
            {file ? file.name : 'Drop a file here, or choose one'}
          </span>
          <span>
            {file
              ? `${formatBytes(file.size)} · ${file.type || 'type detected after upload'}`
              : 'STL, 3MF, OBJ, STEP, G-code, or ZIP'}
          </span>
        </label>
        <label className="form-field">
          <span>Model name</span>
          <input
            required
            maxLength={300}
            value={modelName}
            disabled={upload.isPending}
            onChange={(event) => {
              setModelNameEdited(true);
              setModelName(event.target.value);
            }}
          />
        </label>
        <div className="import-actions">
          <button type="submit" disabled={!file || !modelName.trim() || upload.isPending}>
            {upload.isPending ? 'Uploading…' : 'Upload and import'}
          </button>
          {upload.isPending ? (
            <button
              className="secondary-button"
              type="button"
              onClick={() => cancellation.current?.abort()}
            >
              Cancel upload
            </button>
          ) : null}
        </div>
      </form>

      {upload.isPending ? (
        <ImportProgress value={uploadProgress} label="Uploading original file…" />
      ) : null}
      {upload.isError ? (
        <ImportProblem error={upload.error} onReset={() => upload.mutate()} />
      ) : null}
      {session.isError ? (
        <ImportProblem error={session.error} onReset={() => void session.refetch()} />
      ) : null}
      {session.data ? (
        <ImportReport
          session={session.data}
          duplicateCount={duplicateFiles.length}
          duplicatePending={duplicates.isPending}
          duplicateError={duplicates.error}
          onKeepDuplicates={() => duplicates.mutate()}
          onStartAnother={startAnother}
        />
      ) : null}
    </section>
  );
}

function ImportProgress({ value, label }: { readonly value: number; readonly label: string }) {
  return (
    <section className="import-progress" aria-live="polite" aria-busy={value < 100}>
      <div>
        <strong>{label}</strong>
        <span>{value}%</span>
      </div>
      <progress max={100} value={value}>
        {value}%
      </progress>
    </section>
  );
}

function ImportReport({
  session,
  duplicateCount,
  duplicatePending,
  duplicateError,
  onKeepDuplicates,
  onStartAnother,
}: {
  readonly session: LocalImportSession;
  readonly duplicateCount: number;
  readonly duplicatePending: boolean;
  readonly duplicateError: Error | null;
  readonly onKeepDuplicates: () => void;
  readonly onStartAnother: () => void;
}) {
  const terminal = session.state === 'succeeded' || session.state === 'failed';
  return (
    <section className="import-report" aria-live="polite">
      <header>
        <div>
          <p className="eyebrow">Import status</p>
          <h2>{statusTitle(session)}</h2>
        </div>
        <span className={`import-state state-${session.state}`}>{session.state}</span>
      </header>
      {!terminal && duplicateCount === 0 ? (
        <ImportProgress value={session.progress} label={statusDetail(session.state)} />
      ) : null}
      {session.error ? (
        <div className="import-problem" role="alert">
          <strong>Import failed</strong>
          <p>{session.error.message}</p>
          <p>The original file is retained. Start another import after correcting the problem.</p>
        </div>
      ) : null}
      {duplicateCount > 0 ? (
        <div className="duplicate-decision">
          <h3>Exact duplicates found</h3>
          <p>
            {duplicateCount} {duplicateCount === 1 ? 'file has' : 'files have'} the same content as
            an existing asset. Keeping them creates separate logical assets and does not alter the
            originals.
          </p>
          <button type="button" disabled={duplicatePending} onClick={onKeepDuplicates}>
            {duplicatePending ? 'Confirming…' : 'Keep duplicate files and continue'}
          </button>
          {duplicateError ? <p role="alert">{friendlyError(duplicateError)}</p> : null}
        </div>
      ) : null}
      {session.files && session.files.length > 0 ? (
        <ul className="import-files" aria-label="Imported files">
          {session.files.map((file) => (
            <li key={file.id}>
              <div>
                <strong>{file.originalFilename}</strong>
                <span>
                  {file.isOriginal ? 'Retained original' : file.format?.toUpperCase() || 'Unknown'}
                  {' · '}
                  {formatBytes(file.byteSize)}
                </span>
              </div>
              <span className={`file-status file-${file.status}`}>
                {file.status === 'accepted' ? 'Accepted' : 'Failed'}
              </span>
              {importWarnings(file.warnings).map((warning) => (
                <p className="file-warning" key={`${file.id}-${warning.code}`}>
                  {warning.message}
                </p>
              ))}
              {file.error ? (
                <p className="file-error">
                  {file.error.message}
                  {file.error.retryable ? ' Yuki will retry this processing failure.' : ''}
                </p>
              ) : null}
              {file.duplicateDecision === 'keep' ? (
                <p className="file-note">Exact duplicate explicitly kept.</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <footer className="import-report-actions">
        {session.state === 'succeeded' && session.modelId ? (
          <Link className="button-link" to={`/catalogue/models/${session.modelId}`}>
            View imported model
          </Link>
        ) : null}
        {terminal ? (
          <button className="secondary-button" type="button" onClick={onStartAnother}>
            Import another model
          </button>
        ) : null}
      </footer>
    </section>
  );
}

function ImportProblem({
  error,
  onReset,
}: {
  readonly error: Error;
  readonly onReset: () => void;
}) {
  return (
    <section className="import-problem" role="alert">
      <strong>The upload could not be completed.</strong>
      <p>{friendlyError(error)}</p>
      <button type="button" onClick={onReset}>
        Try again
      </button>
    </section>
  );
}

function friendlyError(error: Error): string {
  if (error.name === 'AbortError') return 'The upload was cancelled. Your file was not imported.';
  if (error instanceof ApiError) {
    if (error.code === 'upload_too_large')
      return 'This file exceeds the configured upload limit. Choose a smaller file or archive.';
    return `${error.message}${error.requestId ? ` Reference: ${error.requestId}.` : ''}`;
  }
  return 'Check the server connection and try again.';
}

function shouldPoll(session: LocalImportSession | undefined): boolean {
  return (
    session !== undefined &&
    session.state !== 'succeeded' &&
    session.state !== 'failed' &&
    !session.files?.some((file) => file.duplicateDecision === 'required')
  );
}

function statusTitle(session: LocalImportSession): string {
  if (session.state === 'succeeded') return `${session.modelName} is ready`;
  if (session.state === 'failed') return `${session.modelName} could not be imported`;
  if (session.files?.some((file) => file.duplicateDecision === 'required'))
    return 'Your decision is required';
  return `${session.modelName} is being prepared`;
}

function statusDetail(state: LocalImportSession['state']): string {
  if (state === 'receiving') return 'Receiving original file…';
  if (state === 'queued') return 'Waiting for the processor…';
  return 'Inspecting and publishing files…';
}

function nameFrom(filename: string): string {
  const withoutExtension = filename.replace(/\.(?:stl|3mf|obj|step|stp|gcode|zip)$/i, '');
  return withoutExtension.replaceAll(/[_-]+/g, ' ').trim().slice(0, 300) || 'Imported model';
}

function requiredSessionId(value: string | null): string {
  if (!value) throw new Error('Import session is unavailable.');
  return value;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}
