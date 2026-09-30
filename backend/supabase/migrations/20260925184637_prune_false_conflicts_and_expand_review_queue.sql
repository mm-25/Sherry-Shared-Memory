-- Earlier summarization compared JSON values, so two claims with the same
-- user-visible statement could have been recorded as a conflict. They are not
-- a choice for the user. Retain both claims, their evidence, and the historical
-- comparison row; only close the false comparison.
update public.memory_conflicts c
set status = 'dismissed', resolution = 'same_statement',
  resolved_at = now(), updated_at = now()
from public.memory_claims l, public.memory_claims r
where c.left_claim_id = l.id and c.right_claim_id = r.id
  and c.status = 'unresolved'
  and lower(btrim(regexp_replace(l.display_text, '[[:space:]]+', ' ', 'g')))
    = lower(btrim(regexp_replace(r.display_text, '[[:space:]]+', ' ', 'g')));

-- Return compact statement text for all distinct candidate pairs. The Worker
-- can then separate near-restatements from genuine decisions *before* the
-- 100-card UI limit is applied. The previous RPC limited to 100 first, which
-- meant hidden duplicates could monopolize the entire page.
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
