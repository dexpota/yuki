import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { useSession } from '../../settings/identity/session.js';
import {
  correctPrintOutcome,
  createManualAttempt,
  listPrinters,
  listPrintAttempts,
  type PrintAttempt,
  type PrintOutcome,
  updatePrintNotes,
  uploadPrintPhoto,
} from './api.js';
import './history.css';

export interface ManualAttemptContext {
  readonly modelId: string;
  readonly currentVersionId: string;
  readonly printCount: number;
  readonly lastPrintedAt: string | null;
  readonly versions: readonly { readonly id: string; readonly label: string }[];
  readonly assets: readonly {
    readonly id: string;
    readonly modelVersionId: string;
    readonly filename: string;
    readonly format: string;
  }[];
}

export function PrintHistoryPage() {
  const session = useSession();
  const [printerId, setPrinterId] = useState('');
  const printers = useQuery({ queryKey: ['printing', 'printers'], queryFn: listPrinters });
  if (session.data?.authenticated !== true) return null;
  return (
    <section className="history-page">
      <header className="history-heading">
        <div>
          <p className="eyebrow">Printing</p>
          <h1>Print history</h1>
          <p>Review attempts across models and printers, including immutable result snapshots.</p>
        </div>
        <label>
          <span>Printer</span>
          <select value={printerId} onChange={(event) => setPrinterId(event.target.value)}>
            <option value="">All printers</option>
            {(printers.data ?? []).map((printer) => (
              <option key={printer.id} value={printer.id}>
                {printer.displayName}
              </option>
            ))}
          </select>
        </label>
      </header>
      <HistoryResults
        csrfToken={session.data.csrfToken}
        filters={printerId ? { printerId } : {}}
        showModel
      />
    </section>
  );
}

export function ModelPrintHistory({
  csrfToken,
  context,
}: {
  readonly csrfToken: string;
  readonly context: ManualAttemptContext;
}) {
  return (
    <section className="catalogue-panel print-history-panel">
      <header className="panel-heading">
        <div>
          <h2>Print history</h2>
          <p>Recorded attempts stay linked to the exact version and G-code used.</p>
        </div>
        <span className="history-count-label">Latest 50</span>
      </header>
      <dl className="history-summary">
        <div>
          <dt>Prints</dt>
          <dd>{context.printCount}</dd>
        </div>
        <div>
          <dt>Last printed</dt>
          <dd>{context.lastPrintedAt ? formatDateTime(context.lastPrintedAt) : 'Never'}</dd>
        </div>
      </dl>
      <ManualAttemptForm csrfToken={csrfToken} context={context} />
      <HistoryResults csrfToken={csrfToken} filters={{ modelId: context.modelId }} />
    </section>
  );
}

function HistoryResults({
  csrfToken,
  filters,
  showModel = false,
}: {
  readonly csrfToken: string;
  readonly filters: { readonly modelId?: string; readonly printerId?: string };
  readonly showModel?: boolean;
}) {
  const history = useQuery({
    queryKey: ['printing', 'history', filters],
    queryFn: () => listPrintAttempts(filters),
  });
  if (history.isPending) return <p aria-busy="true">Loading print history…</p>;
  if (history.isError)
    return (
      <div className="history-status" role="alert">
        <p>Print history could not be loaded.</p>
        <button type="button" onClick={() => void history.refetch()}>
          Try again
        </button>
      </div>
    );
  if (history.data.attempts.length === 0)
    return <p className="history-empty">No print attempts match this view yet.</p>;
  return (
    <ol className="history-list">
      {history.data.attempts.map((attempt) => (
        <li key={attempt.id}>
          <AttemptCard attempt={attempt} csrfToken={csrfToken} showModel={showModel} />
        </li>
      ))}
    </ol>
  );
}

function ManualAttemptForm({
  csrfToken,
  context,
}: {
  readonly csrfToken: string;
  readonly context: ManualAttemptContext;
}) {
  const queryClient = useQueryClient();
  const printers = useQuery({ queryKey: ['printing', 'printers'], queryFn: listPrinters });
  const gcodeAssets = useMemo(
    () => context.assets.filter((asset) => asset.format === 'gcode'),
    [context.assets],
  );
  const [expanded, setExpanded] = useState(false);
  const [versionId, setVersionId] = useState(context.currentVersionId);
  const matchingAssets = gcodeAssets.filter((asset) => asset.modelVersionId === versionId);
  const [assetId, setAssetId] = useState(
    () => gcodeAssets.find((asset) => asset.modelVersionId === context.currentVersionId)?.id ?? '',
  );
  const [printerId, setPrinterId] = useState('');
  const [source, setSource] = useState<'manual' | 'external'>('manual');
  const [outcome, setOutcome] = useState<PrintOutcome>('successful');
  const [startedAt, setStartedAt] = useState(() =>
    localDateTime(new Date(Date.now() - 60 * 60_000)),
  );
  const [completedAt, setCompletedAt] = useState(() => localDateTime(new Date()));
  const [notes, setNotes] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      createManualAttempt(
        {
          modelId: context.modelId,
          modelVersionId: versionId,
          assetId,
          printerId,
          source,
          outcome,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date(completedAt).toISOString(),
          ...(notes ? { notes } : {}),
        },
        csrfToken,
      ),
    onSuccess: () => {
      setExpanded(false);
      setNotes('');
      void queryClient.invalidateQueries({ queryKey: ['printing', 'history'] });
      void queryClient.invalidateQueries({ queryKey: ['catalogue', 'model', context.modelId] });
      void queryClient.invalidateQueries({ queryKey: ['catalogue', 'browse'] });
    },
  });
  const changeVersion = (nextVersionId: string) => {
    setVersionId(nextVersionId);
    setAssetId(gcodeAssets.find((asset) => asset.modelVersionId === nextVersionId)?.id ?? '');
  };

  if (!expanded)
    return (
      <div className="manual-attempt-callout">
        <p>Printed outside Yuki? Add the result to this model’s history.</p>
        <button type="button" disabled={gcodeAssets.length === 0} onClick={() => setExpanded(true)}>
          Record manual attempt
        </button>
        {gcodeAssets.length === 0 ? (
          <small>Add a G-code asset before recording a print.</small>
        ) : null}
      </div>
    );

  return (
    <form
      className="history-form manual-attempt-form"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <div className="history-form-heading">
        <h3>Record an attempt</h3>
        <button className="text-button" type="button" onClick={() => setExpanded(false)}>
          Cancel
        </button>
      </div>
      <div className="history-form-grid">
        <label>
          <span>Version</span>
          <select value={versionId} onChange={(event) => changeVersion(event.target.value)}>
            {context.versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>G-code</span>
          <select required value={assetId} onChange={(event) => setAssetId(event.target.value)}>
            <option value="">Choose G-code</option>
            {matchingAssets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.filename}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Printer</span>
          <select required value={printerId} onChange={(event) => setPrinterId(event.target.value)}>
            <option value="">Choose printer</option>
            {(printers.data ?? []).map((printer) => (
              <option key={printer.id} value={printer.id}>
                {printer.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Source</span>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value as typeof source)}
          >
            <option value="manual">Manual print</option>
            <option value="external">Externally started</option>
          </select>
        </label>
        <label>
          <span>Started</span>
          <input
            required
            type="datetime-local"
            value={startedAt}
            onChange={(event) => setStartedAt(event.target.value)}
          />
        </label>
        <label>
          <span>Completed</span>
          <input
            required
            type="datetime-local"
            value={completedAt}
            onChange={(event) => setCompletedAt(event.target.value)}
          />
        </label>
        <label htmlFor="manual-attempt-outcome">
          <span>Outcome</span>
          <OutcomeSelect id="manual-attempt-outcome" value={outcome} onChange={setOutcome} />
        </label>
      </div>
      <label>
        <span>Notes</span>
        <textarea
          maxLength={10_000}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Optional observations about the result"
        />
      </label>
      <button type="submit" disabled={mutation.isPending || !assetId || !printerId}>
        {mutation.isPending ? 'Recording…' : 'Save attempt'}
      </button>
      <HistoryMutationError failed={mutation.isError} />
    </form>
  );
}

function AttemptCard({
  attempt,
  csrfToken,
  showModel,
}: {
  readonly attempt: PrintAttempt;
  readonly csrfToken: string;
  readonly showModel: boolean;
}) {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState(attempt.notes);
  const [outcome, setOutcome] = useState<PrintOutcome>(attempt.outcome ?? 'unknown');
  const [reason, setReason] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  useEffect(() => setNotes(attempt.notes), [attempt.notes]);
  useEffect(() => setOutcome(attempt.outcome ?? 'unknown'), [attempt.outcome]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['printing', 'history'] });
  };
  const saveNotes = useMutation({
    mutationFn: () => updatePrintNotes(attempt.id, notes, csrfToken),
    onSuccess: refresh,
  });
  const correction = useMutation({
    mutationFn: () => correctPrintOutcome(attempt.id, outcome, reason, csrfToken),
    onSuccess: () => {
      setReason('');
      refresh();
    },
  });
  const upload = useMutation({
    mutationFn: () => uploadPrintPhoto(attempt.id, photo as File, csrfToken),
    onSuccess: () => {
      setPhoto(null);
      refresh();
    },
  });
  const modelName = snapshotText(attempt.modelSnapshot, 'name', 'Deleted model');
  const versionLabel = snapshotText(attempt.modelSnapshot, 'versionLabel', 'Unknown version');
  const filename = snapshotText(attempt.assetSnapshot, 'filename', 'Unknown G-code');
  const printerName = snapshotText(attempt.printerSnapshot, 'name', 'Deleted printer');
  return (
    <article className="attempt-card">
      <header>
        <div>
          <OutcomeBadge outcome={attempt.outcome} />
          <strong>
            {formatDateTime(attempt.completedAt ?? attempt.startedAt ?? attempt.createdAt)}
          </strong>
        </div>
        <span>{sourceLabel(attempt.source)}</span>
      </header>
      <div className="attempt-context">
        {showModel ? (
          attempt.modelId ? (
            <Link to={`/catalogue/models/${encodeURIComponent(attempt.modelId)}`}>{modelName}</Link>
          ) : (
            <span>{modelName}</span>
          )
        ) : null}
        <span>{versionLabel}</span>
        <span>{filename}</span>
        <span>{printerName}</span>
      </div>
      <details>
        <summary>Edit result</summary>
        <div className="attempt-editors">
          <form
            className="history-form"
            onSubmit={(event) => {
              event.preventDefault();
              saveNotes.mutate();
            }}
          >
            <label>
              <span>Notes</span>
              <textarea
                maxLength={10_000}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </label>
            <button type="submit" disabled={saveNotes.isPending || notes === attempt.notes}>
              {saveNotes.isPending ? 'Saving…' : 'Save notes'}
            </button>
          </form>
          <form
            className="history-form"
            onSubmit={(event) => {
              event.preventDefault();
              correction.mutate();
            }}
          >
            <label htmlFor={`attempt-${attempt.id}-outcome`}>
              <span>Correct outcome</span>
              <OutcomeSelect
                id={`attempt-${attempt.id}-outcome`}
                value={outcome}
                onChange={setOutcome}
              />
            </label>
            <label>
              <span>Reason</span>
              <input
                required
                maxLength={1000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <button type="submit" disabled={correction.isPending || !reason.trim()}>
              {correction.isPending ? 'Correcting…' : 'Record correction'}
            </button>
          </form>
          <form
            className="history-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (photo) upload.mutate();
            }}
          >
            <label>
              <span>Add result photo</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
              />
            </label>
            <button type="submit" disabled={upload.isPending || !photo}>
              {upload.isPending ? 'Uploading…' : 'Upload photo'}
            </button>
          </form>
          <HistoryMutationError
            failed={saveNotes.isError || correction.isError || upload.isError}
          />
        </div>
      </details>
      {attempt.photos.length > 0 ? (
        <ul className="attempt-photos" aria-label="Result photos">
          {attempt.photos.map((item) => (
            <li key={item.id}>
              <a href={item.downloadUrl} target="_blank" rel="noreferrer">
                <img src={item.downloadUrl} alt={item.filename} />
                <span>{item.filename}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function OutcomeSelect({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: PrintOutcome;
  readonly onChange: (value: PrintOutcome) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value as PrintOutcome)}
    >
      <option value="successful">Successful</option>
      <option value="failed">Failed</option>
      <option value="cancelled">Cancelled</option>
      <option value="unknown">Unknown</option>
    </select>
  );
}

function OutcomeBadge({ outcome }: { readonly outcome: PrintOutcome | null }) {
  const value = outcome ?? 'in-progress';
  return <span className={`outcome-badge outcome-${value}`}>{outcomeLabel(outcome)}</span>;
}

function HistoryMutationError({ failed }: { readonly failed: boolean }) {
  return failed ? (
    <p className="history-error" role="alert">
      The history change could not be saved. Review the values and try again.
    </p>
  ) : null;
}

function snapshotText(value: unknown, key: string, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate : fallback;
}

function outcomeLabel(outcome: PrintOutcome | null): string {
  if (outcome === null) return 'In progress';
  return `${outcome.slice(0, 1).toUpperCase()}${outcome.slice(1)}`;
}

function sourceLabel(source: PrintAttempt['source']): string {
  if (source === 'remote') return 'Started in Yuki';
  if (source === 'external') return 'External';
  return 'Manual';
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function localDateTime(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
