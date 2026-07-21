create table catalogue_models (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  name text not null check (length(btrim(name)) between 1 and 300),
  description text not null default '',
  import_source text not null check (import_source in ('upload', 'yuki_export')),
  source_url text,
  creator text,
  license text,
  favorite boolean not null default false,
  current_version_id uuid not null,
  cover_asset_id uuid,
  print_count integer not null default 0 check (print_count >= 0),
  last_printed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (id, owner_id)
);

create table catalogue_model_versions (
  id uuid primary key,
  model_id uuid not null references catalogue_models(id) on delete cascade,
  label text not null check (length(btrim(label)) between 1 and 100),
  change_note text,
  metadata_schema_version integer not null check (metadata_schema_version > 0),
  metadata_snapshot jsonb not null check (jsonb_typeof(metadata_snapshot) = 'object'),
  created_at timestamptz not null,
  published_at timestamptz,
  unique (model_id, label),
  unique (id, model_id)
);

create table catalogue_assets (
  id uuid primary key,
  model_id uuid not null,
  model_version_id uuid not null,
  stored_object_id uuid not null references stored_objects(id),
  role text not null check (role in (
    'geometry', 'gcode', 'image', 'document', 'other', 'original_archive'
  )),
  format text not null check (format in (
    'stl', '3mf', 'obj', 'step', 'gcode', 'image', 'document', 'archive', 'other'
  )),
  original_filename text not null check (length(btrim(original_filename)) between 1 and 1024),
  detected_mime_type text not null check (length(btrim(detected_mime_type)) between 1 and 255),
  byte_size bigint not null check (byte_size >= 0),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz not null,
  published_at timestamptz,
  foreign key (model_version_id, model_id)
    references catalogue_model_versions(id, model_id) on delete cascade,
  unique (id, model_id)
);

alter table catalogue_models
  add constraint catalogue_models_current_version_fk
  foreign key (current_version_id, id)
  references catalogue_model_versions(id, model_id)
  deferrable initially deferred;

alter table catalogue_models
  add constraint catalogue_models_cover_asset_fk
  foreign key (cover_asset_id, id)
  references catalogue_assets(id, model_id)
  deferrable initially deferred;

create table catalogue_tags (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  name text not null check (length(btrim(name)) between 1 and 100),
  normalized_name text not null check (normalized_name = lower(btrim(name))),
  created_at timestamptz not null,
  unique (owner_id, normalized_name),
  unique (id, owner_id)
);

create table catalogue_collections (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  normalized_name text not null check (normalized_name = lower(btrim(name))),
  description text not null default '',
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (owner_id, normalized_name),
  unique (id, owner_id)
);

create table catalogue_model_tags (
  model_id uuid not null,
  tag_id uuid not null,
  owner_id uuid not null,
  created_at timestamptz not null,
  primary key (model_id, tag_id),
  foreign key (model_id, owner_id)
    references catalogue_models(id, owner_id) on delete cascade,
  foreign key (tag_id, owner_id)
    references catalogue_tags(id, owner_id) on delete cascade
);

create table catalogue_model_collections (
  model_id uuid not null,
  collection_id uuid not null,
  owner_id uuid not null,
  created_at timestamptz not null,
  primary key (model_id, collection_id),
  foreign key (model_id, owner_id)
    references catalogue_models(id, owner_id) on delete cascade,
  foreign key (collection_id, owner_id)
    references catalogue_collections(id, owner_id) on delete cascade
);

create function catalogue_guard_version_immutability()
returns trigger
language plpgsql
as $$
begin
  if old.published_at is not null then
    if tg_op = 'UPDATE' then
      raise exception 'published catalogue model versions are immutable';
    end if;
    if exists (select 1 from catalogue_models where id = old.model_id) then
      raise exception 'published catalogue model versions are immutable';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.published_at is null and new.published_at is not null then
    if not exists (select 1 from catalogue_assets where model_version_id = new.id) then
      raise exception 'a catalogue model version must contain at least one asset before publication';
    end if;
    if exists (
      select 1 from catalogue_assets
      where model_version_id = new.id and published_at is null
    ) then
      raise exception 'all catalogue assets must be published with their model version';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger catalogue_model_versions_immutable
before update or delete on catalogue_model_versions
for each row execute function catalogue_guard_version_immutability();

create function catalogue_guard_asset()
returns trigger
language plpgsql
as $$
declare
  object_record stored_objects%rowtype;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.published_at is not null then
    if tg_op = 'UPDATE'
      or exists (select 1 from catalogue_model_versions where id = old.model_version_id) then
      raise exception 'published catalogue assets are immutable';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if exists (
    select 1 from catalogue_model_versions
    where id = new.model_version_id and published_at is not null
  ) then
    raise exception 'assets cannot be attached to a published catalogue model version';
  end if;

  select * into object_record from stored_objects where id = new.stored_object_id;
  if not found then
    raise exception 'catalogue asset stored object does not exist';
  end if;
  if object_record.state <> 'committed'
    or object_record.checksum <> new.checksum
    or object_record.byte_size <> new.byte_size then
    raise exception 'catalogue asset metadata does not match its committed stored object';
  end if;

  return new;
end;
$$;

create trigger catalogue_assets_guard
before insert or update or delete on catalogue_assets
for each row execute function catalogue_guard_asset();

create function catalogue_require_published_current_version()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from catalogue_model_versions
    where id = new.current_version_id
      and model_id = new.id
      and published_at is not null
  ) then
    raise exception 'catalogue model current version must be a published version of that model';
  end if;
  return null;
end;
$$;

create constraint trigger catalogue_models_published_current_version
after insert or update of current_version_id on catalogue_models
deferrable initially deferred
for each row execute function catalogue_require_published_current_version();

create index catalogue_model_versions_model_created_idx
  on catalogue_model_versions (model_id, created_at desc, id);
create index catalogue_assets_version_idx
  on catalogue_assets (model_version_id, id);
create index catalogue_assets_model_format_idx
  on catalogue_assets (model_id, format, id);
create index catalogue_model_tags_tag_idx
  on catalogue_model_tags (tag_id, model_id);
create index catalogue_model_collections_collection_idx
  on catalogue_model_collections (collection_id, model_id);
create index catalogue_models_owner_updated_idx
  on catalogue_models (owner_id, updated_at desc, id);
