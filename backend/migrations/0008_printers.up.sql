create table printers (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  display_name text not null check (length(btrim(display_name)) between 1 and 200),
  octoprint_url text not null check (length(octoprint_url) between 8 and 2048),
  encrypted_api_key text not null check (length(encrypted_api_key) > 0),
  enabled boolean not null default true,
  connection_status text not null check (connection_status in ('online', 'offline', 'unknown')),
  operational_state text,
  profile_schema_version integer not null check (profile_schema_version > 0),
  profile jsonb not null check (jsonb_typeof(profile) = 'object'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  verified_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  unique (owner_id, display_name),
  unique (id, owner_id)
);

create index printers_owner_enabled_idx on printers (owner_id, enabled, display_name, id);
