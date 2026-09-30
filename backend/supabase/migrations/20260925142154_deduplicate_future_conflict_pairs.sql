-- Preserve every claim and its evidence, but do not manufacture another set
-- of pairwise conflicts when the same visible statement is captured again.
create or replace function public.create_claim_evidence_and_conflicts()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.origin_checkpoint_id is not null then
    insert into public.memory_evidence (
      workspace_id, memory_claim_id, checkpoint_id, evidence_role
    ) values (
      new.workspace_id, new.id, new.origin_checkpoint_id, 'supports'
    ) on conflict do nothing;
  end if;

  if exists (
    select 1 from public.memory_claims prior
    where prior.workspace_id = new.workspace_id and prior.id <> new.id
      and prior.predicate = new.predicate and prior.scope_type = new.scope_type
      and prior.scope_ref is not distinct from new.scope_ref
      and prior.status in ('provisional', 'confirmed')
      and lower(btrim(regexp_replace(prior.display_text, '[[:space:]]+', ' ', 'g')))
        = lower(btrim(regexp_replace(new.display_text, '[[:space:]]+', ' ', 'g')))
  ) then
    return new;
  end if;

  insert into public.memory_conflicts (workspace_id, left_claim_id, right_claim_id, status)
  select new.workspace_id, existing.id, new.id, 'unresolved'
  from (
    select distinct on (lower(btrim(regexp_replace(prior.display_text, '[[:space:]]+', ' ', 'g'))))
      prior.id, prior.value, prior.display_text
    from public.memory_claims prior
    where prior.workspace_id = new.workspace_id and prior.id <> new.id
      and prior.predicate = new.predicate and prior.scope_type = new.scope_type
      and prior.scope_ref is not distinct from new.scope_ref
      and prior.status in ('provisional', 'confirmed')
    order by lower(btrim(regexp_replace(prior.display_text, '[[:space:]]+', ' ', 'g'))),
      prior.created_at, prior.id
  ) existing
  where existing.value <> new.value
    and lower(btrim(regexp_replace(existing.display_text, '[[:space:]]+', ' ', 'g')))
      <> lower(btrim(regexp_replace(new.display_text, '[[:space:]]+', ' ', 'g')))
  on conflict do nothing;
  return new;
end;
$$;
