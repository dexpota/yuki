drop trigger if exists printing_compatibility_evaluations_immutable
  on printing_compatibility_evaluations;
drop trigger if exists printing_compatibility_evaluations_owner
  on printing_compatibility_evaluations;
drop function if exists printing_guard_compatibility_immutability();
drop function if exists printing_guard_compatibility_owner();
drop table if exists printing_compatibility_evaluations;
