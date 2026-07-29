import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';

import { ApiError } from '../../shared/api/http.js';
import {
  getNotificationDeliveries,
  getNotificationWebhookConfiguration,
  getInstallationSettings,
  type InstallationSettings,
  installationSettingsQueryKey,
  notificationDeliveriesQueryKey,
  notificationWebhookQueryKey,
  updateNotificationWebhookConfiguration,
  updateInstallationSettings,
} from './api.js';
import './settings.css';

export function InstallationSettingsPage({ csrfToken }: { readonly csrfToken: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: installationSettingsQueryKey,
    queryFn: getInstallationSettings,
  });
  const [draft, setDraft] = useState<InstallationSettings | null>(null);
  useEffect(() => {
    if (query.data) setDraft(query.data);
  }, [query.data]);
  const mutation = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('Settings have not loaded');
      return updateInstallationSettings(draft, draft.version, csrfToken);
    },
    onSuccess: (saved) => {
      setDraft(saved);
      queryClient.setQueryData(installationSettingsQueryKey, saved);
    },
  });
  if (query.isError)
    return (
      <main className="settings-page" role="alert">
        Settings could not be loaded.
      </main>
    );
  if (query.isPending || !draft)
    return (
      <main className="settings-page" aria-busy="true">
        Loading settings…
      </main>
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };
  return (
    <main className="settings-page">
      <header>
        <p className="eyebrow">Installation</p>
        <h1>Settings</h1>
        <p>Resource limits and retention rules for this Yuki installation.</p>
      </header>
      <form onSubmit={submit}>
        <SettingsSection title="Limits" description="Guardrails apply before files are processed.">
          <NumberField
            label="Maximum upload (MiB)"
            value={bytesToMib(draft.limits.uploadMaxBytes)}
            min={1}
            max={51_200}
            onChange={(value) =>
              setDraft({ ...draft, limits: { ...draft.limits, uploadMaxBytes: mibToBytes(value) } })
            }
          />
          <NumberField
            label="Archive members"
            value={draft.limits.archiveMaxMembers}
            min={1}
            max={100_000}
            onChange={(value) =>
              setDraft({ ...draft, limits: { ...draft.limits, archiveMaxMembers: value } })
            }
          />
          <NumberField
            label="Expanded archive (MiB)"
            value={bytesToMib(draft.limits.archiveExpandedMaxBytes)}
            min={1}
            max={102_400}
            onChange={(value) =>
              setDraft({
                ...draft,
                limits: { ...draft.limits, archiveExpandedMaxBytes: mibToBytes(value) },
              })
            }
          />
          <NumberField
            label="Compression ratio"
            value={draft.limits.archiveMaxRatio}
            min={1}
            max={10_000}
            onChange={(value) =>
              setDraft({ ...draft, limits: { ...draft.limits, archiveMaxRatio: value } })
            }
          />
        </SettingsSection>
        <SettingsSection
          title="Retention"
          description="Choose how long operational records remain available."
        >
          <NumberField
            label="Trash retention (days)"
            value={draft.retention.trashDays}
            min={1}
            max={3650}
            onChange={(value) =>
              setDraft({ ...draft, retention: { ...draft.retention, trashDays: value } })
            }
          />
          <NumberField
            label="Job retention (days)"
            value={draft.retention.jobDays}
            min={1}
            max={3650}
            onChange={(value) =>
              setDraft({ ...draft, retention: { ...draft.retention, jobDays: value } })
            }
          />
          <NumberField
            label="Printer observations"
            value={draft.retention.observationHistoryEntries}
            min={10}
            max={10_000}
            onChange={(value) =>
              setDraft({
                ...draft,
                retention: { ...draft.retention, observationHistoryEntries: value },
              })
            }
          />
        </SettingsSection>
        <section className="settings-card settings-summary">
          <h2>Authentication</h2>
          <p>Password authentication is active.</p>
          <h2>Printers and storage</h2>
          <p>
            <a href="/printers">Manage printers</a> through the printer configuration feature.
            Storage is installation-managed; credentials are never displayed here.
          </p>
        </section>
        {mutation.error ? <p role="alert">{errorMessage(mutation.error)}</p> : null}
        {mutation.isSuccess ? <p role="status">Settings saved.</p> : null}
        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save settings'}
        </button>
      </form>
      <NotificationWebhookSettings csrfToken={csrfToken} />
    </main>
  );
}

function NotificationWebhookSettings({ csrfToken }: { readonly csrfToken: string }) {
  const queryClient = useQueryClient();
  const configuration = useQuery({
    queryKey: notificationWebhookQueryKey,
    queryFn: getNotificationWebhookConfiguration,
  });
  const deliveries = useQuery({
    queryKey: notificationDeliveriesQueryKey,
    queryFn: getNotificationDeliveries,
  });
  const [enabled, setEnabled] = useState(false);
  const [endpointUrl, setEndpointUrl] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [clearBearerToken, setClearBearerToken] = useState(false);
  useEffect(() => {
    if (configuration.data) setEnabled(configuration.data.enabled);
  }, [configuration.data]);
  const mutation = useMutation({
    mutationFn: () => {
      if (!configuration.data) throw new Error('Webhook configuration has not loaded');
      return updateNotificationWebhookConfiguration(
        {
          enabled,
          expectedVersion: configuration.data.version,
          ...(endpointUrl.trim() ? { endpointUrl: endpointUrl.trim() } : {}),
          ...(bearerToken.trim() ? { bearerToken: bearerToken.trim() } : {}),
          ...(clearBearerToken ? { clearBearerToken: true } : {}),
        },
        csrfToken,
      );
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(notificationWebhookQueryKey, saved);
      queryClient.invalidateQueries({ queryKey: notificationDeliveriesQueryKey });
      setEndpointUrl('');
      setBearerToken('');
      setClearBearerToken(false);
    },
  });
  if (configuration.isPending)
    return (
      <section className="settings-card" aria-busy="true">
        Loading webhook settings…
      </section>
    );
  if (configuration.isError)
    return (
      <section className="settings-card" role="alert">
        Webhook settings could not be loaded.
      </section>
    );
  const saved = configuration.data;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };
  return (
    <form className="settings-card notification-settings" onSubmit={submit}>
      <div>
        <h2>External notifications</h2>
        <p>
          Send versioned HTTPS webhooks for completed, failed, or cancelled prints and active-job
          disconnects. Private-network destinations and redirects are rejected.
        </p>
      </div>
      <label className="settings-field settings-check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span>Enable webhook delivery</span>
      </label>
      <label className="settings-field">
        <span>Webhook URL</span>
        <input
          type="url"
          value={endpointUrl}
          required={!saved.configured}
          placeholder={saved.endpointDisplay ?? 'https://hooks.example.com/yuki'}
          onChange={(event) => setEndpointUrl(event.target.value)}
        />
        {saved.configured ? (
          <small>Configured destination: {saved.endpointDisplay}. Leave blank to keep it.</small>
        ) : null}
      </label>
      <label className="settings-field">
        <span>Bearer token (optional)</span>
        <input
          type="password"
          value={bearerToken}
          autoComplete="new-password"
          placeholder={saved.bearerTokenConfigured ? 'Stored securely; leave blank to keep' : ''}
          onChange={(event) => setBearerToken(event.target.value)}
        />
      </label>
      {saved.bearerTokenConfigured ? (
        <label className="settings-field settings-check">
          <input
            type="checkbox"
            checked={clearBearerToken}
            disabled={bearerToken.trim().length > 0}
            onChange={(event) => setClearBearerToken(event.target.checked)}
          />
          <span>Remove stored bearer token</span>
        </label>
      ) : null}
      {mutation.error ? <p role="alert">{webhookErrorMessage(mutation.error)}</p> : null}
      {mutation.isSuccess ? <p role="status">Webhook settings saved.</p> : null}
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving webhook…' : 'Save webhook'}
      </button>
      <div className="delivery-diagnostics">
        <h3>Recent delivery diagnostics</h3>
        {deliveries.data?.deliveries.length ? (
          <ul>
            {deliveries.data.deliveries.map((delivery) => (
              <li key={delivery.id}>
                <strong>{delivery.title}</strong>: {delivery.state}
                {delivery.attemptCount ? ` after ${delivery.attemptCount} attempt(s)` : ''}
                {delivery.responseStatus ? ` (HTTP ${delivery.responseStatus})` : ''}
                {delivery.lastErrorMessage ? ` — ${delivery.lastErrorMessage}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p>No external deliveries have been attempted yet.</p>
        )}
      </div>
    </form>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="settings-card">
      <h2>{title}</h2>
      <p>{description}</p>
      <div className="settings-grid">{children}</div>
    </section>
  );
}
function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input
        type="number"
        required
        step="1"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
function bytesToMib(value: number) {
  return value / 1024 ** 2;
}
function mibToBytes(value: number) {
  return value * 1024 ** 2;
}
function errorMessage(error: Error) {
  return error instanceof ApiError && error.status === 409
    ? 'Settings changed elsewhere. Reload and try again.'
    : 'Settings could not be saved.';
}

function webhookErrorMessage(error: Error) {
  if (error instanceof ApiError && error.status === 409)
    return 'Webhook settings changed elsewhere. Reload and try again.';
  if (error instanceof ApiError && error.status === 400) return error.message;
  return 'Webhook settings could not be saved.';
}
