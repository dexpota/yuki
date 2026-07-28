drop index if exists printing_queue_entries_active_printer_idx;
alter table printing_queue_entries
  drop constraint if exists printing_queue_entries_attempt_state_check,
  drop constraint if exists printing_queue_entries_attempt_presence_check,
  drop column if exists upstream_path,
  drop column if exists print_attempt_id,
  drop column if exists start_command_job_id;
drop table if exists print_attempts;
drop table if exists printing_start_confirmations;
alter table printing_queue_entries
  drop constraint if exists printing_queue_entries_state_check,
  add constraint printing_queue_entries_state_check check (
    state in ('evaluating', 'blocked', 'queued', 'failed', 'removed')
  );
