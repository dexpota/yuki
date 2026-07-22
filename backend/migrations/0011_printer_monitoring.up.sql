create table printer_observations (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  printer_id uuid not null,
  observed_at timestamptz not null,
  poll_reason text not null check (poll_reason in ('scheduled', 'startup', 'manual', 'reconnect')),
  online boolean not null,
  operational_state text check (
    operational_state is null or operational_state in ('operational', 'printing', 'paused', 'error', 'offline', 'unknown')
  ),
  active_job_kind text not null check (active_job_kind in ('none', 'local', 'external', 'ambiguous')),
  application_job_id uuid,
  upstream_file_name text check (upstream_file_name is null or length(upstream_file_name) <= 1024),
  upstream_file_path text check (upstream_file_path is null or length(upstream_file_path) <= 1024),
  upstream_file_origin text check (upstream_file_origin is null or length(upstream_file_origin) <= 1024),
  progress_percent double precision check (progress_percent is null or progress_percent between 0 and 100),
  elapsed_seconds double precision check (elapsed_seconds is null or elapsed_seconds >= 0),
  remaining_seconds double precision check (remaining_seconds is null or remaining_seconds >= 0),
  temperatures jsonb not null check (jsonb_typeof(temperatures) = 'array'),
  failure_kind text check (
    failure_kind is null or failure_kind in (
      'unauthorized', 'unavailable', 'timeout', 'malformed_response', 'response_too_large', 'destination_rejected'
    )
  ),
  foreign key (printer_id, owner_id) references printers(id, owner_id) on delete cascade,
  check (online or operational_state is null),
  check (online or active_job_kind = 'none'),
  check ((active_job_kind = 'local') = (application_job_id is not null)),
  check ((failure_kind is null) = online)
);

create index printer_observations_owner_printer_time_idx
  on printer_observations (owner_id, printer_id, observed_at desc, id desc);

create table printer_monitoring_state (
  printer_id uuid primary key,
  owner_id uuid not null,
  last_attempt_at timestamptz not null,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_failure_kind text check (
    last_failure_kind is null or last_failure_kind in (
      'unauthorized', 'unavailable', 'timeout', 'malformed_response', 'response_too_large', 'destination_rejected'
    )
  ),
  reconciliation_state text not null check (
    reconciliation_state in (
      'idle', 'local_job_detected', 'external_job_detected', 'ambiguous_active_job', 'offline'
    )
  ),
  updated_at timestamptz not null,
  foreign key (printer_id, owner_id) references printers(id, owner_id) on delete cascade,
  unique (printer_id, owner_id)
);

create index printer_monitoring_state_owner_freshness_idx
  on printer_monitoring_state (owner_id, last_success_at desc, printer_id);
