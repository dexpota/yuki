create table import_sessions (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  state text not null check (state in (
    'receiving', 'queued', 'processing', 'succeeded', 'failed'
  )),
  original_filename text not null check (length(btrim(original_filename)) between 1 and 1024),
  claimed_mime_type text not null check (length(btrim(claimed_mime_type)) between 1 and 255),
  model_name text not null check (length(btrim(model_name)) between 1 and 300),
  idempotency_key text,
  uploaded_bytes bigint not null default 0 check (uploaded_bytes >= 0),
  checksum text check (checksum is null or checksum ~ '^[a-f0-9]{64}$'),
  stored_object_id uuid references stored_objects(id),
  job_id uuid references jobs(id),
  model_id uuid references catalogue_models(id),
  progress integer not null default 0 check (progress between 0 and 100),
  error_code text,
  error_message text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  check (
    (state = 'receiving' and stored_object_id is null and job_id is null and model_id is null)
    or (state in ('queued', 'processing') and stored_object_id is not null and job_id is not null and model_id is null)
    or (state = 'succeeded' and stored_object_id is not null and job_id is not null and model_id is not null and completed_at is not null)
    or (state = 'failed' and model_id is null and completed_at is not null)
  )
);

create unique index import_sessions_owner_idempotency_unique
  on import_sessions (owner_id, idempotency_key)
  where idempotency_key is not null;

create index import_sessions_owner_created_idx
  on import_sessions (owner_id, created_at desc, id);

create index import_sessions_active_idx
  on import_sessions (state, updated_at, id)
  where state in ('receiving', 'queued', 'processing');
