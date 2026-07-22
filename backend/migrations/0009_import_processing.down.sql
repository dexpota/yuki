drop table if exists import_files;
alter table import_sessions
  drop constraint if exists import_sessions_processing_report_check,
  drop column if exists processing_report,
  drop column if exists processing_completed;

alter table import_sessions drop constraint if exists import_sessions_lifecycle_check;
alter table import_sessions add constraint import_sessions_check check (
  (state = 'receiving' and stored_object_id is null and job_id is null and model_id is null)
  or (state in ('queued', 'processing') and stored_object_id is not null and job_id is not null and model_id is null)
  or (state = 'succeeded' and stored_object_id is not null and job_id is not null and model_id is not null and completed_at is not null)
  or (state = 'failed' and model_id is null and completed_at is not null)
);
