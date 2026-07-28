alter table print_attempts
  drop constraint print_attempts_state_check,
  add constraint print_attempts_state_check check (
    state in (
      'starting', 'printing', 'paused', 'reconciliation_required',
      'completed', 'failed', 'cancelled'
    )
  ),
  add column source text not null default 'remote'
    check (source in ('remote', 'manual', 'external')),
  add column notes text not null default '' check (length(notes) <= 10000),
  add column statistics jsonb not null default '{}'::jsonb
    check (jsonb_typeof(statistics) = 'object'),
  add column creation_idempotency_key text,
  add column version integer not null default 1 check (version > 0);

create unique index print_attempts_creation_idempotency_idx
  on print_attempts (owner_id, creation_idempotency_key)
  where creation_idempotency_key is not null;

alter table print_attempts
  drop constraint print_attempts_printer_id_owner_id_fkey,
  alter column printer_id drop not null,
  add constraint print_attempts_printer_owner_fkey
    foreign key (printer_id, owner_id)
    references printers(id, owner_id) on delete set null (printer_id);

create table print_attempt_events (
  id bigint generated always as identity primary key,
  owner_id uuid not null references identity_users(id),
  print_attempt_id uuid not null references print_attempts(id) on delete cascade,
  kind text not null check (
    kind in (
      'created', 'printing', 'paused', 'resumed', 'completed', 'failed',
      'cancelled', 'reconciliation_required', 'observation'
    )
  ),
  facts jsonb not null check (jsonb_typeof(facts) = 'object'),
  recorded_at timestamptz not null,
  unique (id, owner_id)
);

create index print_attempt_events_attempt_time_idx
  on print_attempt_events (owner_id, print_attempt_id, recorded_at, id);

create function printing_record_attempt_creation()
returns trigger
language plpgsql
as $$
begin
  insert into print_attempt_events (
    owner_id, print_attempt_id, kind, facts, recorded_at
  ) values (
    new.owner_id, new.id, 'created', jsonb_build_object('source', new.source), new.created_at
  );
  return new;
end;
$$;

create trigger print_attempts_record_creation
after insert on print_attempts
for each row execute function printing_record_attempt_creation();

insert into print_attempt_events (owner_id, print_attempt_id, kind, facts, recorded_at)
select owner_id, id, 'created', jsonb_build_object('source', source), created_at
from print_attempts;

create table print_attempt_outcome_corrections (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  print_attempt_id uuid not null references print_attempts(id) on delete cascade,
  previous_outcome text check (
    previous_outcome is null
    or previous_outcome in ('successful', 'failed', 'cancelled', 'unknown')
  ),
  outcome text not null check (outcome in ('successful', 'failed', 'cancelled', 'unknown')),
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  idempotency_key text,
  corrected_at timestamptz not null,
  unique (owner_id, idempotency_key)
);

create index print_attempt_outcome_corrections_attempt_idx
  on print_attempt_outcome_corrections (owner_id, print_attempt_id, corrected_at, id);

create table print_attempt_note_revisions (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  print_attempt_id uuid not null references print_attempts(id) on delete cascade,
  notes text not null check (length(notes) <= 10000),
  idempotency_key text,
  created_at timestamptz not null,
  unique (owner_id, idempotency_key)
);

create index print_attempt_note_revisions_attempt_idx
  on print_attempt_note_revisions (owner_id, print_attempt_id, created_at, id);

alter table print_attempts
  add constraint print_attempts_owner_key unique (id, owner_id);

create table print_attempt_photos (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  print_attempt_id uuid not null references print_attempts(id) on delete cascade,
  stored_object_id uuid not null references stored_objects(id),
  original_filename text not null check (length(btrim(original_filename)) between 1 and 1024),
  detected_mime_type text not null check (
    detected_mime_type in ('image/jpeg', 'image/png', 'image/webp')
  ),
  byte_size bigint not null check (byte_size between 1 and 26214400),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  idempotency_key text,
  created_at timestamptz not null,
  foreign key (print_attempt_id, owner_id)
    references print_attempts(id, owner_id) on delete cascade,
  unique (id, owner_id),
  unique (owner_id, idempotency_key)
);

create index print_attempt_photos_attempt_idx
  on print_attempt_photos (owner_id, print_attempt_id, created_at, id);

create function printing_guard_attempt_history()
returns trigger
language plpgsql
as $$
begin
  if old.owner_id is distinct from new.owner_id
    or old.printer_snapshot is distinct from new.printer_snapshot
    or old.model_snapshot is distinct from new.model_snapshot
    or old.asset_snapshot is distinct from new.asset_snapshot
    or old.compatibility_snapshot is distinct from new.compatibility_snapshot
    or old.override_justification is distinct from new.override_justification
    or old.source is distinct from new.source
    or old.created_at is distinct from new.created_at then
    raise exception 'print attempt identity and snapshots are immutable';
  end if;
  return new;
end;
$$;

create trigger print_attempts_immutable_history
before update on print_attempts
for each row execute function printing_guard_attempt_history();

create function printing_reject_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'print history events and revisions are append-only';
end;
$$;

create trigger print_attempt_events_append_only
before update or delete on print_attempt_events
for each row execute function printing_reject_history_mutation();
create trigger print_attempt_outcomes_append_only
before update or delete on print_attempt_outcome_corrections
for each row execute function printing_reject_history_mutation();
create trigger print_attempt_notes_append_only
before update or delete on print_attempt_note_revisions
for each row execute function printing_reject_history_mutation();
