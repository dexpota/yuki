create table jobs (
  id uuid primary key,
  type text not null check (type <> ''),
  payload_version integer not null check (payload_version > 0),
  payload jsonb not null,
  state text not null default 'queued'
    check (state in ('queued', 'running', 'succeeded', 'dead_letter')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null check (max_attempts > 0),
  progress integer not null default 0 check (progress between 0 and 100),
  progress_detail jsonb,
  next_attempt_at timestamptz not null,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  idempotency_key text,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  check (
    (state = 'running' and lease_owner is not null and lease_token is not null and lease_expires_at is not null)
    or
    (state <> 'running' and lease_owner is null and lease_token is null and lease_expires_at is null)
  )
);

create unique index jobs_type_idempotency_key_unique
  on jobs (type, idempotency_key)
  where idempotency_key is not null;

create index jobs_queued_claimable_idx
  on jobs (next_attempt_at, created_at)
  where state = 'queued';

create index jobs_expired_lease_idx
  on jobs (lease_expires_at, created_at)
  where state = 'running';
