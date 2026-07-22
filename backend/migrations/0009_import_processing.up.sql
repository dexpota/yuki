alter table import_sessions drop constraint import_sessions_check;
alter table import_sessions add constraint import_sessions_lifecycle_check check (
  (state = 'receiving' and stored_object_id is null and job_id is null and model_id is null)
  or (state in ('queued', 'processing') and stored_object_id is not null and job_id is not null and model_id is null)
  or (state = 'succeeded' and stored_object_id is not null and job_id is not null and model_id is not null and completed_at is not null)
  or (state = 'failed' and model_id is null and completed_at is not null)
);
alter table import_sessions
  add column processing_completed boolean not null default false,
  add column processing_report jsonb;
alter table import_sessions add constraint import_sessions_processing_report_check check (
  (not processing_completed) or (processing_report is not null and jsonb_typeof(processing_report) = 'object')
);

create table import_files (
  id uuid primary key,
  session_id uuid not null references import_sessions(id) on delete cascade,
  file_key text not null check (length(file_key) between 1 and 4096),
  original_filename text not null check (length(btrim(original_filename)) between 1 and 1024),
  is_original boolean not null,
  stored_object_id uuid references stored_objects(id),
  status text not null check (status in ('accepted', 'failed')),
  role text check (role is null or role in ('geometry', 'gcode', 'image', 'document', 'other', 'original_archive')),
  format text check (format is null or format in ('stl', '3mf', 'obj', 'step', 'gcode', 'image', 'document', 'archive', 'other')),
  detected_mime_type text,
  byte_size bigint not null check (byte_size >= 0),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  detection jsonb,
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  duplicate_asset_ids uuid[] not null default '{}',
  duplicate_decision text not null default 'not_required'
    check (duplicate_decision in ('not_required', 'required', 'keep')),
  error_code text,
  error_message text,
  error_retryable boolean,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (session_id, file_key),
  check (
    (status = 'accepted' and role is not null and format is not null
      and detected_mime_type is not null and detection is not null
      and error_code is null and error_message is null and error_retryable is null)
    or
    (status = 'failed' and stored_object_id is null and role is null and format is null
      and detected_mime_type is null and detection is null
      and error_code is not null and error_message is not null and error_retryable is not null)
  ),
  check (not is_original or file_key = '__original__')
);

create index import_files_session_idx on import_files (session_id, file_key);
create index import_files_duplicate_decision_idx
  on import_files (session_id, duplicate_decision)
  where duplicate_decision = 'required';
