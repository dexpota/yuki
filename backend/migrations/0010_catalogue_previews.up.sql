create table catalogue_generated_artifacts (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  source_asset_id uuid not null references catalogue_assets(id) on delete cascade,
  kind text not null check (kind in ('geometry_preview', 'thumbnail', 'toolpath_preview')),
  status text not null check (status in ('queued', 'processing', 'ready', 'failed', 'unsupported')),
  generator text not null check (length(btrim(generator)) between 1 and 100),
  generator_version text not null check (length(btrim(generator_version)) between 1 and 100),
  stored_object_id uuid references stored_objects(id),
  mime_type text,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  dimensions jsonb,
  summary jsonb,
  failure_code text,
  failure_message text,
  attempt integer not null default 0 check (attempt >= 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  unique (source_asset_id, kind, generator, generator_version),
  check ((status = 'ready') = (stored_object_id is not null)),
  check (status <> 'ready' or (mime_type is not null and byte_size is not null)),
  check (dimensions is null or jsonb_typeof(dimensions) = 'object'),
  check (summary is null or jsonb_typeof(summary) = 'object'),
  check (failure_message is null or length(failure_message) <= 500)
);

create index catalogue_generated_artifacts_owner_asset_idx
  on catalogue_generated_artifacts (owner_id, source_asset_id, kind);
create index catalogue_generated_artifacts_pending_idx
  on catalogue_generated_artifacts (status, updated_at)
  where status in ('queued', 'processing');

create function catalogue_guard_generated_artifact()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from catalogue_assets a
    join catalogue_models m on m.id = a.model_id
    where a.id = new.source_asset_id and m.owner_id = new.owner_id
  ) then
    raise exception 'generated artifact source asset is not owned by owner';
  end if;
  if new.stored_object_id is not null and not exists (
    select 1 from stored_objects
    where id = new.stored_object_id and state = 'committed'
  ) then
    raise exception 'generated artifact must reference a committed stored object';
  end if;
  return new;
end;
$$;

create trigger catalogue_generated_artifacts_guard
before insert or update on catalogue_generated_artifacts
for each row execute function catalogue_guard_generated_artifact();
