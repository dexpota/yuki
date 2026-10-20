import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '../../settings/identity/session.js';
import { addToQueue, listPrinters } from '../printers/index.js';
import { getPrintPlan, orderPrintPlan, type PrintPlanEntry, removeFromPrintPlan } from './api.js';
import './print-plan.css';

export const printPlanQueryKey = ['printing', 'plan'] as const;

export function PrintPlanPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const plan = useQuery({ queryKey: printPlanQueryKey, queryFn: getPrintPlan });
  const printers = useQuery({ queryKey: ['printing', 'printers'], queryFn: listPrinters });
  const csrfToken = session.data?.authenticated === true ? session.data.csrfToken : '';
  const refresh = () => queryClient.invalidateQueries({ queryKey: printPlanQueryKey });
  const remove = useMutation({
    mutationFn: (entryId: string) => removeFromPrintPlan(entryId, csrfToken),
    onSuccess: () => void refresh(),
  });
  const reorder = useMutation({
    mutationFn: (entryIds: readonly string[]) => orderPrintPlan(entryIds, csrfToken),
    onSuccess: (result) => queryClient.setQueryData(printPlanQueryKey, result),
  });

  const entries = [...(plan.data?.entries ?? [])].sort(
    (left, right) => left.position - right.position,
  );
  const move = (entry: PrintPlanEntry, offset: -1 | 1) => {
    const index = entries.findIndex((item) => item.id === entry.id);
    const nextIndex = index + offset;
    if (index < 0 || nextIndex < 0 || nextIndex >= entries.length) return;
    const next = [...entries];
    const currentEntry = next[index];
    const targetEntry = next[nextIndex];
    if (!currentEntry || !targetEntry) return;
    next[index] = targetEntry;
    next[nextIndex] = currentEntry;
    reorder.mutate(next.map((item) => item.id));
  };

  return (
    <section className="print-plan-page">
      <header className="print-plan-heading">
        <div>
          <h1>Print plan</h1>
          <p>Collect models and exact versions you want to print, then choose a printer later.</p>
        </div>
        <Link className="secondary-button" to="/">
          Browse catalogue
        </Link>
      </header>
      {plan.isPending ? <p aria-busy="true">Loading print plan…</p> : null}
      {plan.isError ? (
        <div className="print-plan-status" role="alert">
          <p>The print plan could not be loaded.</p>
          <button type="button" onClick={() => void plan.refetch()}>
            Try again
          </button>
        </div>
      ) : null}
      {printers.isError ? (
        <p className="print-plan-error" role="alert">
          Printer options could not be loaded. Try again after reloading the page.
        </p>
      ) : null}
      {remove.isError || reorder.isError ? (
        <p className="print-plan-error" role="alert">
          {(remove.error ?? reorder.error)?.message ?? 'The print plan could not be updated.'}
        </p>
      ) : null}
      {plan.data?.entries.length === 0 ? (
        <div className="print-plan-empty">
          <h2>Your plan is empty</h2>
          <p>Add a model version from its catalogue page to keep it here for later.</p>
          <Link to="/">Browse models</Link>
        </div>
      ) : null}
      <ol className="print-plan-list" aria-label="Planned prints" aria-busy={reorder.isPending}>
        {entries.map((entry, index) => (
          <li key={entry.id}>
            <article className={`print-plan-card${entry.unavailable ? ' unavailable' : ''}`}>
              <div className="print-plan-card-main">
                <h2>
                  {entry.unavailable ? (
                    entry.modelName
                  ) : (
                    <Link to={`/catalogue/models/${encodeURIComponent(entry.modelId)}`}>
                      {entry.modelName}
                    </Link>
                  )}
                </h2>
                <p>Version {entry.versionLabel}</p>
                {entry.unavailable ? (
                  <p className="print-plan-unavailable" role="status">
                    This model or version is unavailable.
                  </p>
                ) : null}
                {!entry.unavailable ? (
                  <SendToPrinter
                    entry={entry}
                    printers={printers.data ?? []}
                    printersPending={printers.isPending}
                    csrfToken={csrfToken}
                  />
                ) : null}
              </div>
              <div className="print-plan-actions">
                <button
                  className="secondary-button"
                  type="button"
                  aria-label={`Move ${entry.modelName} up`}
                  disabled={index === 0 || reorder.isPending}
                  onClick={() => move(entry, -1)}
                >
                  Move up
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  aria-label={`Move ${entry.modelName} down`}
                  disabled={index === entries.length - 1 || reorder.isPending}
                  onClick={() => move(entry, 1)}
                >
                  Move down
                </button>
                <button
                  className="danger-button"
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(entry.id)}
                >
                  Remove
                </button>
              </div>
            </article>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SendToPrinter({
  entry,
  printers,
  printersPending,
  csrfToken,
}: {
  readonly entry: PrintPlanEntry;
  readonly printers: Awaited<ReturnType<typeof listPrinters>>;
  readonly printersPending: boolean;
  readonly csrfToken: string;
}) {
  const [assetId, setAssetId] = useState('');
  const [printerId, setPrinterId] = useState('');
  const queryClient = useQueryClient();
  const assets = entry.assets;
  const send = useMutation({
    mutationFn: () => addToQueue(printerId, assetId, csrfToken),
    onSuccess: () => {
      setAssetId('');
      void queryClient.invalidateQueries({ queryKey: ['printing', 'queue', printerId] });
    },
  });

  if (printersPending) return <p aria-busy="true">Loading printers…</p>;
  if (printers.length === 0) return <p>Add a printer before sending this print.</p>;
  return (
    <form
      className="print-plan-send-form"
      onSubmit={(event) => {
        event.preventDefault();
        send.mutate();
      }}
    >
      <label>
        <span>G-code file</span>
        <select required value={assetId} onChange={(event) => setAssetId(event.target.value)}>
          <option value="">Choose a file from this version</option>
          {assets.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.filename}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Printer</span>
        <select required value={printerId} onChange={(event) => setPrinterId(event.target.value)}>
          <option value="">Choose a printer</option>
          {printers.map((printer) => (
            <option key={printer.id} value={printer.id}>
              {printer.displayName}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={send.isPending || !assetId || !printerId || assets.length === 0}
      >
        {send.isPending ? 'Sending…' : 'Send to printer queue'}
      </button>
      {assets.length === 0 ? <p>No G-code file exists in this version.</p> : null}
      {send.isError ? <p role="alert">{send.error.message}</p> : null}
      {send.isSuccess ? (
        <p role="status">Added to the printer queue. This item remains in your print plan.</p>
      ) : null}
    </form>
  );
}
