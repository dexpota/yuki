alter table printing_queue_entries
  drop constraint printing_queue_entries_state_check,
  add constraint printing_queue_entries_state_check check (
    state in (
      'evaluating', 'blocked', 'queued', 'uploading', 'uploaded', 'starting',
      'printing', 'paused', 'completed', 'cancelled', 'reconciliation_required',
      'failed', 'removed'
    )
  );

create table printing_start_confirmations (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  printer_id uuid not null,
  queue_entry_id uuid not null references printing_queue_entries(id) on delete cascade,
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  challenge_snapshot jsonb not null check (jsonb_typeof(challenge_snapshot) = 'object'),
  issuance_idempotency_key text,
  consumption_idempotency_key text,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  foreign key (printer_id, owner_id) references printers(id, owner_id) on delete cascade,
  unique (token_hash),
  unique (owner_id, issuance_idempotency_key),
  unique (owner_id, consumption_idempotency_key),
  check (expires_at > created_at),
  check ((consumed_at is null) = (consumption_idempotency_key is null))
);

create index printing_start_confirmations_entry_idx
  on printing_start_confirmations (owner_id, queue_entry_id, expires_at desc);

create table print_attempts (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  queue_entry_id uuid unique references printing_queue_entries(id) on delete set null,
  printer_id uuid not null,
  model_id uuid,
  model_version_id uuid,
  asset_id uuid,
  state text not null check (state in ('starting', 'printing', 'reconciliation_required', 'failed')),
  outcome text check (outcome is null or outcome in ('successful', 'failed', 'cancelled', 'unknown')),
  printer_snapshot jsonb not null check (jsonb_typeof(printer_snapshot) = 'object'),
  model_snapshot jsonb not null check (jsonb_typeof(model_snapshot) = 'object'),
  asset_snapshot jsonb not null check (jsonb_typeof(asset_snapshot) = 'object'),
  compatibility_snapshot jsonb not null check (jsonb_typeof(compatibility_snapshot) = 'object'),
  override_justification text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  foreign key (printer_id, owner_id) references printers(id, owner_id),
  foreign key (model_id, owner_id)
    references catalogue_models(id, owner_id) on delete set null (model_id),
  foreign key (model_version_id, model_id)
    references catalogue_model_versions(id, model_id) on delete set null,
  foreign key (asset_id, model_id) references catalogue_assets(id, model_id) on delete set null,
  check (state <> 'printing' or started_at is not null),
  check ((outcome is null) = (completed_at is null))
);

create index print_attempts_owner_created_idx
  on print_attempts (owner_id, created_at desc, id);

alter table printing_queue_entries
  add column start_command_job_id uuid references jobs(id) on delete set null,
  add column print_attempt_id uuid references print_attempts(id),
  add column upstream_path text check (upstream_path is null or length(upstream_path) <= 1024),
  add constraint printing_queue_entries_attempt_state_check check (
    state not in (
      'uploading', 'uploaded', 'starting', 'printing', 'paused', 'completed',
      'cancelled', 'reconciliation_required'
    ) or print_attempt_id is not null
  ),
  add constraint printing_queue_entries_attempt_presence_check check (
    print_attempt_id is null or state in (
      'uploading', 'uploaded', 'starting', 'printing', 'paused', 'completed',
      'cancelled', 'reconciliation_required', 'failed'
    )
  );

create unique index printing_queue_entries_active_printer_idx
  on printing_queue_entries (printer_id)
  where state in ('uploading', 'uploaded', 'starting', 'printing', 'paused', 'reconciliation_required');
