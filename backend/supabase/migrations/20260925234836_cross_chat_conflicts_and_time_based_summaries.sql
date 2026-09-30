-- A conversation can revise or refine its own summary without asking the
-- user to arbitrate between checkpoints of that same source. Keep the claims,
-- evidence, and comparison history; remove only these pairs from the queue.
update public.memory_conflicts c
set status = 'dismissed', resolution = 'same_conversation',
  resolved_at = now(), updated_at = now()
from public.memory_claims l, public.memory_claims r
where c.left_claim_id = l.id and c.right_claim_id = r.id
  and c.status = 'unresolved'
  and l.conversation_id is not null
  and l.conversation_id = r.conversation_id;

-- Future comparisons require two distinct source conversations. Claims with
-- no source chat remain reviewable as facts, but cannot create a cross-chat
-- conflict without evidence of two different chats.
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

  if new.conversation_id is null then return new; end if;

  if exists (
    select 1 from public.memory_claims prior
    where prior.workspace_id = new.workspace_id and prior.id <> new.id
      and prior.conversation_id = new.conversation_id
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
      and prior.conversation_id is not null
      and prior.conversation_id <> new.conversation_id
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

-- Exclude stale same-chat rows defensively even if a historical row is
-- restored or inserted outside the normal trigger path.
create or replace function public.list_review_conflicts(
  p_workspace_id uuid,
  p_limit integer default 2000
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with candidate as (
    select
      c.id,
      l.display_text as left_text,
      r.display_text as right_text,
      row_number() over (
        partition by c.workspace_id, l.predicate, l.scope_type, coalesce(l.scope_ref, ''),
          least(lower(btrim(regexp_replace(l.display_text, '[[:space:]]+', ' ', 'g'))), lower(btrim(regexp_replace(r.display_text, '[[:space:]]+', ' ', 'g')))),
          greatest(lower(btrim(regexp_replace(l.display_text, '[[:space:]]+', ' ', 'g'))), lower(btrim(regexp_replace(r.display_text, '[[:space:]]+', ' ', 'g'))))
        order by c.created_at desc, c.id desc
      ) as position,
      count(*) over (
        partition by c.workspace_id, l.predicate, l.scope_type, coalesce(l.scope_ref, ''),
          least(lower(btrim(regexp_replace(l.display_text, '[[:space:]]+', ' ', 'g'))), lower(btrim(regexp_replace(r.display_text, '[[:space:]]+', ' ', 'g')))),
          greatest(lower(btrim(regexp_replace(l.display_text, '[[:space:]]+', ' ', 'g'))), lower(btrim(regexp_replace(r.display_text, '[[:space:]]+', ' ', 'g'))))
      ) as repeated_count
    from public.memory_conflicts c
    join public.memory_claims l on l.id = c.left_claim_id and l.workspace_id = p_workspace_id
    join public.memory_claims r on r.id = c.right_claim_id and r.workspace_id = p_workspace_id
    where c.workspace_id = p_workspace_id
      and c.status = 'unresolved'
      and l.status in ('provisional', 'confirmed')
      and r.status in ('provisional', 'confirmed')
      and l.conversation_id is not null
      and r.conversation_id is not null
      and l.conversation_id <> r.conversation_id
      and lower(btrim(regexp_replace(l.display_text, '[[:space:]]+', ' ', 'g')))
        <> lower(btrim(regexp_replace(r.display_text, '[[:space:]]+', ' ', 'g')))
  ),
  distinct_pairs as (
    select c.*, candidate.repeated_count,
      candidate.left_text, candidate.right_text
    from candidate
    join public.memory_conflicts c on c.id = candidate.id
    where candidate.position = 1
  ),
  recent as (
    select * from distinct_pairs
    order by created_at desc, id desc
    limit least(greatest(coalesce(p_limit, 2000), 1), 2000)
  )
  select jsonb_build_object(
    'total', (select count(*) from distinct_pairs),
    'items', coalesce((select jsonb_agg(to_jsonb(recent) order by recent.created_at desc, recent.id desc) from recent), '[]'::jsonb)
  );
$$;

revoke execute on function public.list_review_conflicts(uuid, integer) from public, anon, authenticated;
grant execute on function public.list_review_conflicts(uuid, integer) to service_role;
