drop trigger if exists print_attempt_notes_append_only on print_attempt_note_revisions;
drop trigger if exists print_attempt_outcomes_append_only on print_attempt_outcome_corrections;
drop trigger if exists print_attempt_events_append_only on print_attempt_events;
drop function if exists printing_reject_history_mutation();
drop trigger if exists print_attempts_immutable_history on print_attempts;
drop function if exists printing_guard_attempt_history();
drop trigger if exists print_attempts_record_creation on print_attempts;
drop function if exists printing_record_attempt_creation();
drop table if exists print_attempt_photos;
drop table if exists print_attempt_note_revisions;
drop table if exists print_attempt_outcome_corrections;
drop table if exists print_attempt_events;
update print_attempts
set state = 'failed'
where state in ('paused', 'completed', 'cancelled');
alter table print_attempts
  drop constraint if exists print_attempts_owner_key,
  drop constraint if exists print_attempts_printer_owner_fkey,
  alter column printer_id set not null,
  add constraint print_attempts_printer_id_owner_id_fkey
    foreign key (printer_id, owner_id) references printers(id, owner_id),
  drop column if exists version,
  drop column if exists statistics,
  drop column if exists notes,
  drop column if exists creation_idempotency_key,
  drop column if exists source,
  drop constraint if exists print_attempts_state_check,
  add constraint print_attempts_state_check check (
    state in ('starting', 'printing', 'reconciliation_required', 'failed')
  );
