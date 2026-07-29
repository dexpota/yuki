create index print_attempts_owner_history_idx
  on print_attempts (
    owner_id,
    (coalesce(completed_at, started_at, created_at)) desc,
    id desc
  );

create index print_attempts_owner_model_history_idx
  on print_attempts (
    owner_id,
    model_id,
    (coalesce(completed_at, started_at, created_at)) desc,
    id desc
  );

create index print_attempts_owner_printer_history_idx
  on print_attempts (
    owner_id,
    printer_id,
    (coalesce(completed_at, started_at, created_at)) desc,
    id desc
  );

create index print_attempts_owner_failed_model_idx
  on print_attempts (owner_id, model_id)
  where outcome = 'failed';
