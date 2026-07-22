create table catalogue_portability_operations (
  id uuid primary key,
  owner_id uuid not null references identity_users(id),
  kind text not null check (kind in ('export', 'import')),
  state text not null check (state in ('queued', 'running', 'succeeded', 'failed')),
  source_model_id uuid references catalogue_models(id) on delete set null,
  imported_model_id uuid references catalogue_models(id) on delete set null,
  input_stored_object_id uuid references stored_objects(id),
  output_stored_object_id uuid references stored_objects(id),
  job_id uuid not null references jobs(id),
  idempotency_key text,
  error_code text,
  error_message text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  check (
    (kind = 'export' and source_model_id is not null and input_stored_object_id is null)
    or (kind = 'import' and source_model_id is null and input_stored_object_id is not null)
  ),
  check (
    (state = 'succeeded' and completed_at is not null and error_code is null and error_message is null)
    or (state = 'failed' and completed_at is not null and error_code is not null and error_message is not null)
    or (state in ('queued', 'running') and completed_at is null and error_code is null and error_message is null)
  )
);

create unique index catalogue_portability_idempotency_unique
  on catalogue_portability_operations (owner_id, kind, idempotency_key)
  where idempotency_key is not null;

create index catalogue_portability_owner_created_idx
  on catalogue_portability_operations (owner_id, created_at desc, id);
