create table printing_control_confirmations (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  printer_id uuid not null,
  queue_entry_id uuid references printing_queue_entries(id) on delete cascade,
  action text not null check (
    action in (
      'pause', 'resume', 'cancel', 'set_tool_temperature',
      'set_bed_temperature', 'home'
    )
  ),
  parameters jsonb not null check (jsonb_typeof(parameters) = 'object'),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  challenge_snapshot jsonb not null check (jsonb_typeof(challenge_snapshot) = 'object'),
  consumption_idempotency_key text,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  foreign key (printer_id, owner_id) references printers(id, owner_id) on delete cascade,
  unique (owner_id, consumption_idempotency_key),
  check (expires_at > created_at),
  check ((consumed_at is null) = (consumption_idempotency_key is null))
);

create index printing_control_confirmations_printer_idx
  on printing_control_confirmations (owner_id, printer_id, expires_at desc);

create table printing_control_commands (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  printer_id uuid not null,
  queue_entry_id uuid references printing_queue_entries(id) on delete set null,
  confirmation_id uuid not null unique references printing_control_confirmations(id),
  job_id uuid not null unique references jobs(id) on delete restrict,
  action text not null check (
    action in (
      'pause', 'resume', 'cancel', 'set_tool_temperature',
      'set_bed_temperature', 'home'
    )
  ),
  parameters jsonb not null check (jsonb_typeof(parameters) = 'object'),
  state text not null check (
    state in ('pending', 'completed', 'failed', 'reconciliation_required')
  ),
  result_code text,
  created_at timestamptz not null,
  completed_at timestamptz,
  foreign key (printer_id, owner_id) references printers(id, owner_id) on delete cascade,
  check ((state = 'pending') = (completed_at is null))
);

create index printing_control_commands_printer_idx
  on printing_control_commands (owner_id, printer_id, created_at desc);

create table printer_control_events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references identity_users(id),
  printer_id uuid not null,
  command_id uuid not null references printing_control_commands(id) on delete cascade,
  queue_entry_id uuid references printing_queue_entries(id) on delete set null,
  action text not null,
  outcome text not null check (
    outcome in ('accepted', 'completed', 'failed', 'reconciliation_required')
  ),
  facts jsonb not null check (jsonb_typeof(facts) = 'object'),
  recorded_at timestamptz not null,
  foreign key (printer_id, owner_id) references printers(id, owner_id) on delete cascade
);

create index printer_control_events_printer_idx
  on printer_control_events (owner_id, printer_id, recorded_at, id);

create function printing_reject_control_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'printer control events are append-only';
end;
$$;

create trigger printer_control_events_append_only
before update or delete on printer_control_events
for each row execute function printing_reject_control_event_mutation();
