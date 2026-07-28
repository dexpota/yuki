drop trigger if exists printer_observations_create_disconnect_notification on printer_observations;
drop function if exists printing_notify_printer_disconnect();
drop trigger if exists print_attempts_create_terminal_notification on print_attempts;
drop function if exists printing_notify_terminal_attempt();
drop function if exists printing_create_notification(
  uuid, text, uuid, uuid, text, text, jsonb, text, timestamptz
);
delete from jobs where type = 'notification.external.delivery';
drop table if exists notifications;
