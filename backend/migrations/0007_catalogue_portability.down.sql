with removed as (
  delete from stored_object_references
  where owner_type in ('catalogue_portability_input', 'catalogue_portability_export')
  returning stored_object_id
), counts as (
  select stored_object_id, count(*)::integer as removed_count
  from removed
  group by stored_object_id
)
update stored_objects as object
set reference_count = greatest(0, object.reference_count - counts.removed_count),
    updated_at = now()
from counts
where object.id = counts.stored_object_id;

drop table if exists catalogue_portability_operations;
