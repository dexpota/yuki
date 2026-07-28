create table notifications (
  id uuid primary key,
  owner_id uuid not null references identity_users(id) on delete cascade,
  kind text not null check (kind in ('print_completed', 'print_failed', 'print_cancelled', 'printer_disconnected')),
  print_attempt_id uuid references print_attempts(id) on delete set null,
  printer_id uuid references printers(id) on delete set null,
  title text not null check (length(btrim(title)) between 1 and 200),
  message text not null check (length(btrim(message)) between 1 and 2000),
  facts jsonb not null check (jsonb_typeof(facts) = 'object'),
  deduplication_key text not null check (length(deduplication_key) between 1 and 500),
  read_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  unique (owner_id, deduplication_key)
);

create index notifications_owner_time_idx
  on notifications (owner_id, created_at desc, id desc);

create index notifications_owner_unread_idx
  on notifications (owner_id, created_at desc)
  where read_at is null;

create function printing_create_notification(
  notification_owner_id uuid,
  notification_kind text,
  notification_attempt_id uuid,
  notification_printer_id uuid,
  notification_title text,
  notification_message text,
  notification_facts jsonb,
  notification_deduplication_key text,
  notification_created_at timestamptz
)
returns uuid
language plpgsql
as $$
declare
  notification_id uuid;
begin
  insert into notifications (
    id, owner_id, kind, print_attempt_id, printer_id, title, message, facts,
    deduplication_key, read_at, created_at, updated_at, version
  ) values (
    gen_random_uuid(), notification_owner_id, notification_kind,
    notification_attempt_id, notification_printer_id, notification_title,
    notification_message, notification_facts, notification_deduplication_key,
    null, notification_created_at, notification_created_at, 1
  )
  on conflict (owner_id, deduplication_key) do nothing
  returning id into notification_id;

  if notification_id is null then
    select id into notification_id
    from notifications
    where owner_id = notification_owner_id
      and deduplication_key = notification_deduplication_key;
  end if;

  insert into jobs (
    id, type, payload_version, payload, state, attempts, max_attempts, progress,
    next_attempt_at, idempotency_key, created_at, updated_at
  ) values (
    gen_random_uuid(), 'notification.external.delivery', 1,
    jsonb_build_object(
      'schemaVersion', 1,
      'notificationId', notification_id,
      'ownerId', notification_owner_id
    ),
    'queued', 0, 5, 0, notification_created_at, notification_id::text,
    notification_created_at, notification_created_at
  )
  on conflict (type, idempotency_key) where idempotency_key is not null do nothing;

  return notification_id;
end;
$$;

create function printing_notify_terminal_attempt()
returns trigger
language plpgsql
as $$
declare
  notification_kind text;
  notification_title text;
  printer_name text;
  file_name text;
begin
  if new.source <> 'remote'
    or old.state in ('completed', 'failed', 'cancelled')
    or new.state not in ('completed', 'failed', 'cancelled') then
    return new;
  end if;

  printer_name := coalesce(new.printer_snapshot ->> 'name', 'Printer');
  file_name := coalesce(new.asset_snapshot ->> 'filename', 'print');
  notification_kind := case new.state
    when 'failed' then 'print_failed'
    when 'cancelled' then 'print_cancelled'
    else 'print_completed'
  end;
  notification_title := case new.state
    when 'failed' then 'Print failed'
    when 'cancelled' then 'Print cancelled'
    else 'Print completed'
  end;

  perform printing_create_notification(
    new.owner_id,
    notification_kind,
    new.id,
    new.printer_id,
    notification_title,
    printer_name || ': ' || file_name,
    jsonb_build_object(
      'schemaVersion', 1,
      'attemptId', new.id,
      'outcome', new.outcome,
      'state', new.state
    ),
    'print-attempt:' || new.id::text || ':' || notification_kind,
    new.updated_at
  );
  return new;
end;
$$;

create trigger print_attempts_create_terminal_notification
after update of state on print_attempts
for each row execute function printing_notify_terminal_attempt();

create function printing_notify_printer_disconnect()
returns trigger
language plpgsql
as $$
declare
  previous_observation printer_observations%rowtype;
  printer_name text;
begin
  if new.online then
    return new;
  end if;

  select * into previous_observation
  from printer_observations
  where owner_id = new.owner_id
    and printer_id = new.printer_id
    and id <> new.id
  order by observed_at desc, id desc
  limit 1;

  if previous_observation.id is null
    or not previous_observation.online
    or previous_observation.active_job_kind = 'none' then
    return new;
  end if;

  select display_name into printer_name
  from printers
  where id = new.printer_id and owner_id = new.owner_id;

  perform printing_create_notification(
    new.owner_id,
    'printer_disconnected',
    null,
    new.printer_id,
    'Printer disconnected',
    coalesce(printer_name, 'Printer') || ' disconnected during an active print.',
    jsonb_build_object(
      'schemaVersion', 1,
      'failureKind', new.failure_kind,
      'activeJobKind', previous_observation.active_job_kind,
      'applicationJobId', previous_observation.application_job_id
    ),
    'printer-disconnected:' || new.printer_id::text || ':' || new.id::text,
    new.observed_at
  );
  return new;
end;
$$;

create trigger printer_observations_create_disconnect_notification
after insert on printer_observations
for each row execute function printing_notify_printer_disconnect();
