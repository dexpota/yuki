import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cloneElement,
  type FormEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Link, useParams } from 'react-router';

import { getModel, searchCatalogue } from '../../catalogue/api.js';
import { useSession } from '../../settings/identity/session.js';
import {
  acceptControl,
  acceptStart,
  addToQueue,
  type CompatibilityCheck,
  type ControlChallenge,
  type ControlRequest,
  createPrinter,
  getMonitoring,
  issueControl,
  issueStart,
  listPrinters,
  listQueue,
  overrideQueueEntry,
  printerEventsUrl,
  type Printer,
  type PrinterInput,
  removePrinter,
  removeQueueEntry,
  reorderQueue,
  type StartChallenge,
  updatePrinter,
  verifyPrinter,
  webcamSnapshotUrl,
} from './api.js';
import './printers.css';

const refreshIntervalMs = 5_000;

export function PrintersPage() {
  const session = useSession();
  const [adding, setAdding] = useState(false);
  const printers = useQuery({ queryKey: ['printing', 'printers'], queryFn: listPrinters });
  if (session.data?.authenticated !== true) return null;
  return (
    <section className="printers-page">
      <header className="printers-heading">
        <div>
          <p className="eyebrow">Printing</p>
          <h1>Printers</h1>
          <p>Configure OctoPrint endpoints, inspect live state, and manage each print queue.</p>
        </div>
        <button type="button" onClick={() => setAdding((current) => !current)}>
          {adding ? 'Cancel' : 'Add printer'}
        </button>
      </header>
      {adding ? (
        <PrinterForm csrfToken={session.data.csrfToken} onSaved={() => setAdding(false)} />
      ) : null}
      {printers.isPending ? <p aria-busy="true">Loading printers…</p> : null}
      {printers.isError ? <LoadError retry={() => void printers.refetch()} /> : null}
      {printers.data?.length === 0 ? (
        <div className="printer-empty">
          <h2>No printers configured</h2>
          <p>Add an OctoPrint printer. Its address and credential are verified before saving.</p>
        </div>
      ) : null}
      <ol className="printer-grid">
        {(printers.data ?? []).map((printer) => (
          <li key={printer.id}>
            <Link className="printer-card" to={`/printers/${printer.id}`}>
              <div>
                <span className={`status-dot status-${printer.connectionStatus}`} />
                <strong>{printer.displayName}</strong>
              </div>
              <span>
                {printer.enabled ? (printer.operationalState ?? 'Unknown state') : 'Disabled'}
              </span>
              <small>
                {printer.connectionStatus} · {printer.profile.buildVolume.widthMm} ×{' '}
                {printer.profile.buildVolume.depthMm} × {printer.profile.buildVolume.heightMm} mm
              </small>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function PrinterDetailPage() {
  const session = useSession();
  const { printerId = '' } = useParams();
  const [editing, setEditing] = useState(false);
  usePrinterEvents(printerId);
  const printers = useQuery({ queryKey: ['printing', 'printers'], queryFn: listPrinters });
  const printer = printers.data?.find((candidate) => candidate.id === printerId);
  if (session.data?.authenticated !== true) return null;
  if (printers.isPending) return <p aria-busy="true">Loading printer…</p>;
  if (printers.isError) return <LoadError retry={() => void printers.refetch()} />;
  if (printer === undefined)
    return (
      <section className="route-message">
        <p className="eyebrow">Printing</p>
        <h1>Printer not found</h1>
        <Link to="/printers">Return to printers</Link>
      </section>
    );
  return (
    <section className="printer-detail">
      <header className="printer-detail-heading">
        <div>
          <Link to="/printers">← All printers</Link>
          <p className="eyebrow">Printer workspace</p>
          <h1>{printer.displayName}</h1>
        </div>
        <button type="button" onClick={() => setEditing((current) => !current)}>
          {editing ? 'Close settings' : 'Configure'}
        </button>
      </header>
      {editing ? (
        <PrinterForm
          csrfToken={session.data.csrfToken}
          printer={printer}
          onSaved={() => setEditing(false)}
        />
      ) : null}
      <MonitoringPanel printer={printer} csrfToken={session.data.csrfToken} />
      <QueuePanel printer={printer} csrfToken={session.data.csrfToken} />
    </section>
  );
}

function MonitoringPanel({
  printer,
  csrfToken,
}: {
  readonly printer: Printer;
  readonly csrfToken: string;
}) {
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const [webcamUnavailable, setWebcamUnavailable] = useState(false);
  const monitoring = useQuery({
    queryKey: ['printing', 'monitoring', printer.id],
    queryFn: () => getMonitoring(printer.id),
    refetchInterval: refreshIntervalMs,
  });
  const facts =
    monitoring.data?.stale === true
      ? (monitoring.data.lastGood ?? monitoring.data.current)
      : (monitoring.data?.current ?? monitoring.data?.lastGood);
  return (
    <section className="printer-panel monitoring-panel">
      <header className="panel-heading">
        <div>
          <h2>Monitor</h2>
          <p>Printer facts refresh every five seconds; stale observations remain visibly marked.</p>
        </div>
        {monitoring.data ? (
          <span className={`freshness freshness-${monitoring.data.freshness}`}>
            {monitoring.data.freshness.replace('_', ' ')}
          </span>
        ) : null}
      </header>
      {monitoring.isPending ? <p aria-busy="true">Reading printer state…</p> : null}
      {monitoring.isError ? <LoadError retry={() => void monitoring.refetch()} /> : null}
      {monitoring.data?.freshness === 'never_observed' ? (
        <p className="printer-notice">The worker has not observed this printer yet.</p>
      ) : null}
      {monitoring.data?.stale ? (
        <p className="stale-warning" role="status">
          Live contact is stale. Values below are the last known observations from{' '}
          {facts ? formatDateTime(facts.observedAt) : 'an earlier poll'}.
        </p>
      ) : null}
      {facts ? (
        <div className="monitor-layout">
          <div>
            <dl className="monitor-stats">
              <Metric label="State" value={facts.operationalState ?? 'Unknown'} />
              <Metric
                label="Job"
                value={facts.activeJob.upstreamFileName ?? label(facts.activeJob.kind)}
              />
              <Metric
                label="Progress"
                value={
                  facts.progressPercent === null ? '—' : `${Math.round(facts.progressPercent)}%`
                }
              />
              <Metric label="Elapsed" value={duration(facts.elapsedSeconds)} />
              <Metric label="Remaining" value={duration(facts.remainingSeconds)} />
              <Metric label="Observed" value={formatDateTime(facts.observedAt)} />
            </dl>
            {facts.progressPercent !== null ? (
              <progress max="100" value={facts.progressPercent}>
                {facts.progressPercent}%
              </progress>
            ) : null}
            <div className="temperature-list">
              {facts.temperatures.map((temperature) => (
                <span key={temperature.component}>
                  {temperature.component}: {temperature.actualCelsius ?? '—'}° /{' '}
                  {temperature.targetCelsius ?? '—'}°
                </span>
              ))}
            </div>
            <PrinterControls
              printerId={printer.id}
              {...(facts.activeJob.kind === 'local' && facts.activeJob.applicationJobId
                ? { queueEntryId: facts.activeJob.applicationJobId }
                : {})}
              state={facts.operationalState}
              csrfToken={csrfToken}
            />
          </div>
          <div className="webcam-frame">
            <img
              src={webcamSnapshotUrl(
                printer.id,
                Math.max(snapshotRevision, Date.parse(facts.observedAt) || 0),
              )}
              alt={`Webcam snapshot for ${printer.displayName}`}
              onLoad={() => setWebcamUnavailable(false)}
              onError={() => setWebcamUnavailable(true)}
            />
            {webcamUnavailable ? (
              <p>This printer has no available same-origin webcam snapshot.</p>
            ) : null}
            <button type="button" onClick={() => setSnapshotRevision(Date.now())}>
              Refresh snapshot
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function PrinterControls({
  printerId,
  queueEntryId,
  state,
  csrfToken,
}: {
  readonly printerId: string;
  readonly queueEntryId?: string;
  readonly state: string | null;
  readonly csrfToken: string;
}) {
  const queryClient = useQueryClient();
  const [challenge, setChallenge] = useState<ControlChallenge | null>(null);
  const [target, setTarget] = useState('0');
  const issue = useMutation({
    mutationFn: (request: ControlRequest) => issueControl(printerId, request, csrfToken),
    onSuccess: setChallenge,
  });
  const accept = useMutation({
    mutationFn: () => acceptControl(printerId, challenge?.token ?? '', csrfToken),
    onSuccess: () => {
      setChallenge(null);
      void queryClient.invalidateQueries({ queryKey: ['printing', 'monitoring', printerId] });
    },
  });
  const request = (control: ControlRequest) => issue.mutate(control);
  return (
    <div className="printer-controls">
      <h3>Confirmed controls</h3>
      <div className="control-row">
        {state === 'printing' ? (
          <button
            type="button"
            onClick={() => request({ action: 'pause', ...(queueEntryId ? { queueEntryId } : {}) })}
          >
            Pause
          </button>
        ) : null}
        {state === 'paused' ? (
          <button
            type="button"
            onClick={() => request({ action: 'resume', ...(queueEntryId ? { queueEntryId } : {}) })}
          >
            Resume
          </button>
        ) : null}
        {state === 'printing' || state === 'paused' ? (
          <button
            className="danger-button"
            type="button"
            onClick={() => request({ action: 'cancel', ...(queueEntryId ? { queueEntryId } : {}) })}
          >
            Cancel print
          </button>
        ) : null}
        <button type="button" onClick={() => request({ action: 'home', axes: ['x', 'y', 'z'] })}>
          Home axes
        </button>
      </div>
      <div className="temperature-control">
        <label>
          <span>Target °C</span>
          <input
            type="number"
            min="0"
            max="350"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() =>
            request({
              action: 'set_tool_temperature',
              tool: 'tool0',
              targetCelsius: Number(target),
            })
          }
        >
          Set tool
        </button>
        <button
          type="button"
          onClick={() => request({ action: 'set_bed_temperature', targetCelsius: Number(target) })}
        >
          Set bed
        </button>
      </div>
      {issue.isError ? <MutationError error={issue.error} /> : null}
      {accept.isError ? <MutationError error={accept.error} /> : null}
      {challenge ? (
        <Confirmation
          title={`Confirm ${label(challenge.action)}`}
          notice={challenge.safetyNotice}
          expiresAt={challenge.expiresAt}
          busy={accept.isPending}
          onCancel={() => setChallenge(null)}
          onConfirm={() => accept.mutate()}
        />
      ) : null}
    </div>
  );
}

function QueuePanel({
  printer,
  csrfToken,
}: {
  readonly printer: Printer;
  readonly csrfToken: string;
}) {
  const queryClient = useQueryClient();
  const [challenge, setChallenge] = useState<{ entryId: string; value: StartChallenge } | null>(
    null,
  );
  const [overrideEntry, setOverrideEntry] = useState<string | null>(null);
  const [justification, setJustification] = useState('');
  const queue = useQuery({
    queryKey: ['printing', 'queue', printer.id],
    queryFn: () => listQueue(printer.id),
    refetchInterval: refreshIntervalMs,
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['printing', 'queue', printer.id] });
  const remove = useMutation({
    mutationFn: (entryId: string) => removeQueueEntry(printer.id, entryId, csrfToken),
    onSuccess: () => void invalidate(),
  });
  const reorder = useMutation({
    mutationFn: (entryIds: readonly string[]) => reorderQueue(printer.id, entryIds, csrfToken),
    onSuccess: () => void invalidate(),
  });
  const override = useMutation({
    mutationFn: (entryId: string) =>
      overrideQueueEntry(printer.id, entryId, justification, csrfToken),
    onSuccess: () => {
      setOverrideEntry(null);
      setJustification('');
      void invalidate();
    },
  });
  const startIssue = useMutation({
    mutationFn: (entryId: string) => issueStart(entryId, csrfToken),
    onSuccess: (value, entryId) => setChallenge({ entryId, value }),
  });
  const startAccept = useMutation({
    mutationFn: () =>
      acceptStart(challenge?.entryId ?? '', challenge?.value.token ?? '', csrfToken),
    onSuccess: () => {
      setChallenge(null);
      void invalidate();
    },
  });
  const entries = queue.data?.entries ?? [];
  const move = (index: number, offset: number) => {
    const next = [...entries];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [
      next[target] as (typeof next)[number],
      next[index] as (typeof next)[number],
    ];
    reorder.mutate(next.map((entry) => entry.id));
  };
  return (
    <section className="printer-panel queue-panel">
      <header className="panel-heading">
        <div>
          <h2>Print queue</h2>
          <p>Compatibility is evaluated before an item can be started. Items never auto-start.</p>
        </div>
      </header>
      <QueueAssetPicker printerId={printer.id} csrfToken={csrfToken} />
      {queue.isPending ? <p aria-busy="true">Loading queue…</p> : null}
      {queue.isError ? <LoadError retry={() => void queue.refetch()} /> : null}
      {entries.length === 0 && !queue.isPending ? <p>The queue is empty.</p> : null}
      <ol className="queue-list">
        {entries.map((entry, index) => {
          const checks = entry.compatibilitySnapshot?.result?.checks ?? [];
          return (
            <li key={entry.id}>
              <div className="queue-entry-heading">
                <div>
                  <strong>Asset {shortId(entry.assetId)}</strong>
                  <span className={`queue-state state-${entry.state}`}>{label(entry.state)}</span>
                  {entry.compatibilityStatus ? (
                    <span className={`compatibility compatibility-${entry.compatibilityStatus}`}>
                      {entry.compatibilityStatus}
                    </span>
                  ) : null}
                </div>
                <div className="queue-entry-actions">
                  <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={index === entries.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                  {entry.state === 'queued' ? (
                    <button type="button" onClick={() => startIssue.mutate(entry.id)}>
                      Review & start
                    </button>
                  ) : null}
                  {entry.state === 'blocked' ? (
                    <button type="button" onClick={() => setOverrideEntry(entry.id)}>
                      Override
                    </button>
                  ) : null}
                  {['evaluating', 'blocked', 'queued', 'failed'].includes(entry.state) ? (
                    <button
                      className="danger-button"
                      type="button"
                      onClick={() => remove.mutate(entry.id)}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
              {entry.error ? <p className="queue-error">{entry.error.message}</p> : null}
              <CompatibilityChecks checks={checks} />
              {overrideEntry === entry.id ? (
                <form
                  className="override-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    override.mutate(entry.id);
                  }}
                >
                  <label>
                    <span>Safety justification</span>
                    <textarea
                      required
                      minLength={10}
                      value={justification}
                      onChange={(event) => setJustification(event.target.value)}
                    />
                  </label>
                  <button type="submit" disabled={override.isPending}>
                    Apply override
                  </button>
                  <button type="button" onClick={() => setOverrideEntry(null)}>
                    Cancel
                  </button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ol>
      {remove.isError ? <MutationError error={remove.error} /> : null}
      {reorder.isError ? <MutationError error={reorder.error} /> : null}
      {override.isError ? <MutationError error={override.error} /> : null}
      {startIssue.isError ? <MutationError error={startIssue.error} /> : null}
      {startAccept.isError ? <MutationError error={startAccept.error} /> : null}
      {challenge ? (
        <Confirmation
          title={`Start ${challenge.value.file.filename}?`}
          notice={challenge.value.safetyNotice}
          expiresAt={challenge.value.expiresAt}
          busy={startAccept.isPending}
          details={[
            `${formatBytes(challenge.value.file.byteSize)} · ${challenge.value.compatibilityStatus}`,
            ...challenge.value.warnings,
          ]}
          onCancel={() => setChallenge(null)}
          onConfirm={() => startAccept.mutate()}
        />
      ) : null}
    </section>
  );
}

function QueueAssetPicker({
  printerId,
  csrfToken,
}: {
  readonly printerId: string;
  readonly csrfToken: string;
}) {
  const queryClient = useQueryClient();
  const [modelId, setModelId] = useState('');
  const [assetId, setAssetId] = useState('');
  const models = useQuery({
    queryKey: ['catalogue', 'gcode-options'],
    queryFn: () => searchCatalogue({ format: 'gcode', sort: 'updatedAt', direction: 'desc' }),
  });
  const model = useQuery({
    queryKey: ['catalogue', 'model', modelId],
    queryFn: () => getModel(modelId),
    enabled: modelId !== '',
  });
  const assets = useMemo(
    () =>
      model.data?.assets.filter(
        (asset) =>
          asset.format === 'gcode' &&
          asset.model_version_id === model.data.model.current_version_id,
      ) ?? [],
    [model.data],
  );
  const add = useMutation({
    mutationFn: () => addToQueue(printerId, assetId, csrfToken),
    onSuccess: () => {
      setAssetId('');
      void queryClient.invalidateQueries({ queryKey: ['printing', 'queue', printerId] });
    },
  });
  return (
    <form
      className="queue-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate();
      }}
    >
      <label>
        <span>Model</span>
        <select
          required
          value={modelId}
          onChange={(event) => {
            setModelId(event.target.value);
            setAssetId('');
          }}
        >
          <option value="">Choose a model with G-code</option>
          {(models.data?.items ?? []).map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Current-version G-code</span>
        <select
          required
          disabled={!model.data}
          value={assetId}
          onChange={(event) => setAssetId(event.target.value)}
        >
          <option value="">Choose a file</option>
          {assets.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.original_filename}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={add.isPending || assetId === ''}>
        Add to queue
      </button>
      {add.isError ? <MutationError error={add.error} /> : null}
    </form>
  );
}

function PrinterForm({
  csrfToken,
  printer,
  onSaved,
}: {
  readonly csrfToken: string;
  readonly printer?: Printer;
  readonly onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const build = printer?.profile.buildVolume;
  const compatibility = printer?.profile.compatibility;
  const [name, setName] = useState(printer?.displayName ?? '');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(printer?.enabled ?? true);
  const [shape, setShape] = useState<'rectangular' | 'circular'>(build?.shape ?? 'rectangular');
  const [origin, setOrigin] = useState<'lowerleft' | 'center'>(build?.origin ?? 'lowerleft');
  const [width, setWidth] = useState(String(build?.widthMm ?? 220));
  const [depth, setDepth] = useState(String(build?.depthMm ?? 220));
  const [height, setHeight] = useState(String(build?.heightMm ?? 250));
  const [flavors, setFlavors] = useState(compatibility?.gcodeFlavors.join(', ') ?? 'marlin');
  const [nozzle, setNozzle] = useState(String(compatibility?.nozzleDiameterMm ?? 0.4));
  const [extruders, setExtruders] = useState(String(compatibility?.extruderCount ?? 1));
  const input = (): PrinterInput => ({
    displayName: name,
    ...(url ? { octoprintUrl: url } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(printer ? { enabled, expectedVersion: printer.version } : {}),
    profile: {
      buildVolume: {
        shape,
        origin,
        widthMm: Number(width),
        depthMm: Number(depth),
        heightMm: Number(height),
      },
      compatibility: {
        gcodeFlavors: flavors
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        nozzleDiameterMm: nozzle === '' ? null : Number(nozzle),
        extruderCount: Number(extruders),
      },
    },
  });
  const save = useMutation({
    mutationFn: () =>
      printer ? updatePrinter(printer.id, input(), csrfToken) : createPrinter(input(), csrfToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['printing', 'printers'] });
      onSaved();
    },
  });
  const verify = useMutation({
    mutationFn: () => verifyPrinter(printer?.id ?? '', csrfToken),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['printing', 'printers'] }),
  });
  const remove = useMutation({
    mutationFn: () => removePrinter(printer?.id ?? '', csrfToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['printing', 'printers'] });
      window.location.assign('/printers');
    },
  });
  return (
    <form
      className="printer-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h2>{printer ? 'Printer configuration' : 'Connect an OctoPrint printer'}</h2>
      <div className="printer-form-grid">
        <Field label="Display name">
          <input required value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={printer ? 'New OctoPrint URL (optional)' : 'OctoPrint URL'}>
          <input
            required={!printer}
            type="url"
            placeholder={printer ? 'Saved address remains hidden' : 'http://printer.local/'}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <Field label={printer ? 'New API key (optional)' : 'API key'}>
          <input
            required={!printer}
            type="password"
            autoComplete="new-password"
            placeholder={printer ? 'Credential is configured' : ''}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>
        <Field label="Build shape">
          <select value={shape} onChange={(event) => setShape(event.target.value as typeof shape)}>
            <option value="rectangular">Rectangular</option>
            <option value="circular">Circular</option>
          </select>
        </Field>
        <Field label="Build origin">
          <select
            value={origin}
            onChange={(event) => setOrigin(event.target.value as typeof origin)}
          >
            <option value="lowerleft">Lower left</option>
            <option value="center">Center</option>
          </select>
        </Field>
        <NumberField label="Width / diameter (mm)" value={width} onChange={setWidth} />
        <NumberField label="Depth (mm)" value={depth} onChange={setDepth} />
        <NumberField label="Height (mm)" value={height} onChange={setHeight} />
        <Field label="G-code flavors (comma-separated)">
          <input required value={flavors} onChange={(event) => setFlavors(event.target.value)} />
        </Field>
        <NumberField label="Nozzle diameter (mm)" value={nozzle} onChange={setNozzle} step="0.05" />
        <NumberField label="Extruders" value={extruders} onChange={setExtruders} step="1" />
        {printer ? (
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>Monitoring enabled</span>
          </label>
        ) : null}
      </div>
      <div className="printer-form-actions">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Verifying…' : printer ? 'Save configuration' : 'Verify and add'}
        </button>
        {printer ? (
          <>
            <button type="button" disabled={verify.isPending} onClick={() => verify.mutate()}>
              Verify saved connection
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete printer
            </button>
          </>
        ) : null}
      </div>
      {save.isError ? <MutationError error={save.error} /> : null}
      {verify.isSuccess ? <p className="success-notice">Connection verified.</p> : null}
      {verify.isError ? <MutationError error={verify.error} /> : null}
      {remove.isError ? <MutationError error={remove.error} /> : null}
    </form>
  );
}

function CompatibilityChecks({ checks }: { readonly checks: readonly CompatibilityCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <details className="compatibility-checks">
      <summary>Compatibility details</summary>
      <ul>
        {checks.map((check) => (
          <li key={check.rule}>
            <strong>{label(check.status)}</strong> {check.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Confirmation({
  title,
  notice,
  expiresAt,
  details = [],
  busy,
  onConfirm,
  onCancel,
}: {
  readonly title: string;
  readonly notice: string;
  readonly expiresAt: string;
  readonly details?: readonly string[];
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="confirmation-backdrop" role="presentation">
      <section
        className="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
      >
        <p className="eyebrow">Physical action</p>
        <h2 id="confirmation-title">{title}</h2>
        <p>{notice}</p>
        {details.map((detail) => (
          <p key={detail}>{detail}</p>
        ))}
        <small>Confirmation expires {formatDateTime(expiresAt)}.</small>
        <div>
          <button type="button" disabled={busy} onClick={onConfirm}>
            Confirm action
          </button>
          <button type="button" onClick={onCancel}>
            Go back
          </button>
        </div>
      </section>
    </div>
  );
}

function Metric({ label: name, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Field({
  label: name,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement<{ readonly id?: string }>;
}) {
  const id = `printer-field-${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`;
  return (
    <div className="form-field">
      <label htmlFor={id}>{name}</label>
      {cloneElement(children, { id })}
    </div>
  );
}

function NumberField({
  label: name,
  value,
  onChange,
  step = '0.1',
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly step?: string;
}) {
  return (
    <Field label={name}>
      <input
        required
        type="number"
        min="0.01"
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function LoadError({ retry }: { readonly retry: () => void }) {
  return (
    <div className="printer-notice" role="alert">
      <p>Printer information could not be loaded.</p>
      <button type="button" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

function MutationError({ error }: { readonly error: Error }) {
  return (
    <p className="queue-error" role="alert">
      {error.message}
    </p>
  );
}

function usePrinterEvents(printerId: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (printerId === '' || typeof EventSource === 'undefined') return;
    const source = new EventSource(printerEventsUrl(printerId));
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: ['printing', 'printers'] });
      void queryClient.invalidateQueries({ queryKey: ['printing', 'monitoring', printerId] });
      void queryClient.invalidateQueries({ queryKey: ['printing', 'queue', printerId] });
    };
    source.addEventListener('printer-invalidated', invalidate);
    source.addEventListener('refresh-required', invalidate);
    return () => {
      source.removeEventListener('printer-invalidated', invalidate);
      source.removeEventListener('refresh-required', invalidate);
      source.close();
    };
  }, [printerId, queryClient]);
}

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}
