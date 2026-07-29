create table notification_webhook_configurations (
  owner_id uuid primary key references identity_users(id) on delete cascade,
  endpoint_origin text not null check (length(endpoint_origin) between 1 and 512),
  encrypted_endpoint_url text not null,
  encrypted_bearer_token text,
  enabled boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version integer not null check (version > 0)
);

create table notification_deliveries (
  id uuid primary key,
  owner_id uuid not null references identity_users(id) on delete cascade,
  notification_id uuid not null references notifications(id) on delete cascade,
  channel text not null check (channel = 'webhook'),
  state text not null check (state in ('pending', 'retrying', 'succeeded', 'failed', 'disabled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  response_status integer check (response_status between 100 and 599),
  last_error_code text check (last_error_code is null or length(last_error_code) between 1 and 100),
  last_error_message text check (last_error_message is null or length(last_error_message) between 1 and 500),
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (owner_id, notification_id)
);

create index notification_deliveries_owner_time_idx
  on notification_deliveries (owner_id, updated_at desc, id desc);

create function printing_create_notification_delivery()
returns trigger
language plpgsql
as $$
begin
  insert into notification_deliveries (
    id, owner_id, notification_id, channel, state, attempt_count,
    response_status, last_error_code, last_error_message, last_attempt_at,
    delivered_at, created_at, updated_at
  ) values (
    gen_random_uuid(), new.owner_id, new.id, 'webhook', 'pending', 0,
    null, null, null, null, null, new.created_at, new.created_at
  );
  return new;
end;
$$;

create trigger notifications_create_delivery
after insert on notifications
for each row execute function printing_create_notification_delivery();

insert into notification_deliveries (
  id, owner_id, notification_id, channel, state, attempt_count,
  response_status, last_error_code, last_error_message, last_attempt_at,
  delivered_at, created_at, updated_at
)
select
  gen_random_uuid(), notification.owner_id, notification.id, 'webhook', 'pending', 0,
  null, null, null, null, null, notification.created_at, notification.created_at
from notifications notification
on conflict (owner_id, notification_id) do nothing;
