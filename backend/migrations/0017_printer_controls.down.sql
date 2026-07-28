drop trigger if exists printer_control_events_append_only on printer_control_events;
drop function if exists printing_reject_control_event_mutation();
drop table if exists printer_control_events;
drop table if exists printing_control_commands;
drop table if exists printing_control_confirmations;
