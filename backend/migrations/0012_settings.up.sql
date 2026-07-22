create table installation_settings (
  owner_id uuid primary key references identity_users(id) on delete cascade,
  upload_max_bytes bigint not null check (upload_max_bytes between 1048576 and 53687091200),
  archive_max_members integer not null check (archive_max_members between 1 and 100000),
  archive_expanded_max_bytes bigint not null check (archive_expanded_max_bytes between 1048576 and 107374182400),
  archive_max_ratio integer not null check (archive_max_ratio between 1 and 10000),
  trash_retention_days integer not null check (trash_retention_days between 1 and 3650),
  job_retention_days integer not null check (job_retention_days between 1 and 3650),
  observation_history_entries integer not null check (observation_history_entries between 10 and 10000),
  authentication_mode text not null check (authentication_mode = 'password'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version integer not null check (version > 0)
);
