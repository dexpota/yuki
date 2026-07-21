create table identity_users (
  id uuid primary key,
  singleton_key boolean not null default true check (singleton_key),
  username text not null check (char_length(username) between 1 and 100),
  normalized_username text not null check (char_length(normalized_username) between 1 and 100),
  password_hash text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (singleton_key),
  unique (normalized_username)
);

create table identity_sessions (
  id uuid primary key,
  owner_id uuid not null references identity_users(id) on delete cascade,
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  last_seen_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null,
  unique (token_hash),
  check (idle_expires_at <= expires_at),
  check (last_seen_at >= created_at)
);

create index identity_sessions_owner_idx on identity_sessions (owner_id);
create index identity_sessions_active_expiry_idx
  on identity_sessions (idle_expires_at, expires_at)
  where revoked_at is null;
