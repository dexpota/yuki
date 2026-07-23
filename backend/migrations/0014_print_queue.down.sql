drop trigger if exists printing_queue_entries_owner on printing_queue_entries;
drop function if exists printing_guard_queue_entry_owner();
drop table if exists printing_queue_entries;
alter table printing_compatibility_evaluations
  drop constraint if exists printing_compatibility_evaluations_owner_key;
