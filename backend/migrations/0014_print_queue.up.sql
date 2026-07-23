alter table printing_compatibility_evaluations
  add constraint printing_compatibility_evaluations_owner_key unique (id, owner_id);

create table printing_queue_entries (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  printer_id uuid not null,
  asset_id uuid not null references catalogue_assets(id) on delete cascade,
  evaluation_job_id uuid references jobs(id) on delete set null,
  compatibility_evaluation_id uuid,
  state text not null check (state in ('evaluating', 'blocked', 'queued', 'failed', 'removed')),
  position integer,
  compatibility_status text check (
    compatibility_status is null
    or compatibility_status in ('compatible', 'warning', 'unknown', 'incompatible')
  ),
  compatibility_snapshot jsonb,
  override_justification text check (
    override_justification is null
    or length(btrim(override_justification)) between 1 and 500
  ),
  error_code text,
  error_message text check (error_message is null or length(error_message) <= 500),
  idempotency_key text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  foreign key (printer_id, owner_id) references printers(id, owner_id) on delete cascade,
  foreign key (compatibility_evaluation_id, owner_id)
    references printing_compatibility_evaluations(id, owner_id),
  unique (owner_id, idempotency_key),
  constraint printing_queue_position_unique
    unique (printer_id, position) deferrable initially deferred,
  check ((state = 'queued') = (position is not null)),
  check (position is null or position >= 0),
  check (
    (
      compatibility_evaluation_id is null
      and compatibility_status is null
      and compatibility_snapshot is null
    )
    or (
      compatibility_evaluation_id is not null
      and compatibility_status is not null
      and compatibility_snapshot is not null
    )
  ),
  check (
    state not in ('queued', 'blocked')
    or compatibility_evaluation_id is not null
  ),
  check (
    state <> 'queued'
    or compatibility_status = 'compatible'
    or (
      compatibility_status in ('warning', 'unknown')
      and override_justification is not null
    )
  ),
  check (state <> 'queued' or compatibility_status <> 'incompatible')
);

create index printing_queue_entries_queue_idx
  on printing_queue_entries (printer_id, position)
  where state = 'queued';
create index printing_queue_entries_owner_idx
  on printing_queue_entries (owner_id, printer_id, state, created_at);

create function printing_guard_queue_entry_owner()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from catalogue_assets asset
    join catalogue_models model on model.id = asset.model_id
    where asset.id = new.asset_id
      and asset.format = 'gcode'
      and model.owner_id = new.owner_id
  ) then
    raise exception 'queue entry asset is not an owner-scoped G-code asset';
  end if;
  return new;
end;
$$;

create trigger printing_queue_entries_owner
before insert or update of asset_id, owner_id on printing_queue_entries
for each row execute function printing_guard_queue_entry_owner();
