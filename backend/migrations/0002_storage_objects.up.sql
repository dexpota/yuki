create table stored_objects (
  id uuid primary key,
  backend text not null,
  object_key text not null,
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  byte_size bigint not null check (byte_size >= 0),
  state text not null check (state in ('committed', 'pending_delete', 'deleting', 'deletion_failed')),
  reference_count integer not null default 0 check (reference_count >= 0),
  delete_after timestamptz,
  deletion_error text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (backend, object_key),
  check ((state in ('pending_delete', 'deletion_failed') and reference_count = 0 and delete_after is not null)
    or (state = 'deleting' and reference_count = 0)
    or (state = 'committed' and delete_after is null))
);

create table stored_object_references (
  stored_object_id uuid not null references stored_objects(id) on delete cascade,
  owner_type text not null,
  owner_id text not null,
  created_at timestamptz not null,
  primary key (owner_type, owner_id),
  unique (stored_object_id, owner_type, owner_id)
);

create index stored_objects_deletion_due_idx
  on stored_objects (delete_after, id)
  where reference_count = 0 and state in ('pending_delete', 'deletion_failed');

create index stored_object_references_object_idx
  on stored_object_references (stored_object_id);
