-- A pair of visible statements is one review decision, even when multiple
-- summaries emitted equivalent claim rows. This function does not mutate data.
grant select on public.memory_claims, public.memory_conflicts to service_role;


create or replace function public.list_review_conflicts(
  p_workspace_id uuid,
  p_limit integer default 100
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
  ),
  distinct_pairs as (
    select c.*, candidate.repeated_count
    from candidate
    join public.memory_conflicts c on c.id = candidate.id
    where candidate.position = 1
  ),
  recent as (
    select * from distinct_pairs
    order by created_at desc, id desc
    limit least(greatest(coalesce(p_limit, 100), 1), 300)
  )
  select jsonb_build_object(
    'total', (select count(*) from distinct_pairs),
    'items', coalesce((select jsonb_agg(to_jsonb(recent) order by recent.created_at desc, recent.id desc) from recent), '[]'::jsonb)
  );
$$;

revoke execute on function public.list_review_conflicts(uuid, integer) from public, anon, authenticated;
grant execute on function public.list_review_conflicts(uuid, integer) to service_role;

-- One choice applies to every active claim with the same visible statement in
-- this predicate/scope, and closes all repeated rows for that statement pair.
-- If one side is superseded, conflicts involving that side are no longer live.
create or replace function public.resolve_memory_conflict(
  p_workspace_id uuid,
  p_conflict_id uuid,
  p_resolution text,
  p_actor_user_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_conflict public.memory_conflicts%rowtype;
  v_left public.memory_claims%rowtype;
  v_right public.memory_claims%rowtype;
  v_left_ids uuid[];
  v_right_ids uuid[];
  v_loser_ids uuid[];
  v_resolved_id uuid;
  v_status text := 'resolved';
  v_affected integer := 0;
  v_additional integer := 0;
begin
  if p_resolution not in ('keep_left', 'keep_right', 'keep_both', 'dismiss') then
    raise data_exception using message = 'invalid_conflict_resolution';
  end if;

  -- Serialize decisions in this workspace before locking any conflict row.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('memory-conflict:' || p_workspace_id::text, 0));
  select * into v_conflict from public.memory_conflicts
  where id = p_conflict_id and workspace_id = p_workspace_id for update;
  if v_conflict.id is null then
    raise no_data_found using message = 'memory_conflict_not_found';
  end if;
  if v_conflict.status <> 'unresolved' then
    return jsonb_build_object('conflictId', v_conflict.id, 'status', v_conflict.status, 'idempotentReplay', true);
  end if;

  select * into v_left from public.memory_claims where id = v_conflict.left_claim_id and workspace_id = p_workspace_id;
  select * into v_right from public.memory_claims where id = v_conflict.right_claim_id and workspace_id = p_workspace_id;
  if v_left.id is null or v_right.id is null
     or v_left.status not in ('provisional', 'confirmed')
     or v_right.status not in ('provisional', 'confirmed') then
    raise data_exception using message = 'conflict_claim_no_longer_active';
  end if;

  select coalesce(array_agg(id), '{}'::uuid[]) into v_left_ids
  from public.memory_claims
  where workspace_id = p_workspace_id
    and predicate = v_left.predicate and scope_type = v_left.scope_type
    and scope_ref is not distinct from v_left.scope_ref
    and status in ('provisional', 'confirmed')
    and lower(btrim(regexp_replace(display_text, '[[:space:]]+', ' ', 'g')))
      = lower(btrim(regexp_replace(v_left.display_text, '[[:space:]]+', ' ', 'g')));
  select coalesce(array_agg(id), '{}'::uuid[]) into v_right_ids
  from public.memory_claims
  where workspace_id = p_workspace_id
    and predicate = v_right.predicate and scope_type = v_right.scope_type
    and scope_ref is not distinct from v_right.scope_ref
    and status in ('provisional', 'confirmed')
    and lower(btrim(regexp_replace(display_text, '[[:space:]]+', ' ', 'g')))
      = lower(btrim(regexp_replace(v_right.display_text, '[[:space:]]+', ' ', 'g')));

  if p_resolution <> 'dismiss' then
    insert into public.memory_claim_reviews (
      workspace_id, memory_claim_id, actor_user_id, decision,
      previous_status, new_status, previous_review_state, new_review_state, detail
    )
    select p_workspace_id, claim.id, p_actor_user_id, 'conflict_' || p_resolution,
      claim.status,
      case when (p_resolution = 'keep_left' and claim.id = any(v_right_ids))
             or (p_resolution = 'keep_right' and claim.id = any(v_left_ids))
           then 'superseded' else 'confirmed' end,
      claim.review_state,
      case when (p_resolution = 'keep_left' and claim.id = any(v_right_ids))
             or (p_resolution = 'keep_right' and claim.id = any(v_left_ids))
           then 'no' else 'yes' end,
      jsonb_build_object('conflictId', v_conflict.id, 'groupedDecision', true)
    from public.memory_claims claim
    where claim.id = any(v_left_ids) or claim.id = any(v_right_ids);

    if p_resolution in ('keep_left', 'keep_right') then
      v_loser_ids := case when p_resolution = 'keep_left' then v_right_ids else v_left_ids end;
      v_resolved_id := case when p_resolution = 'keep_left' then v_left.id else v_right.id end;
    end if;
    update public.memory_claims claim set
      status = case when claim.id = any(v_loser_ids) then 'superseded' else 'confirmed' end,
      review_state = case when claim.id = any(v_loser_ids) then 'no' else 'yes' end,
      authority = case when claim.id = any(v_loser_ids) then claim.authority else 'user_confirmed' end,
      reviewed_at = p_now,
      updated_at = p_now
    where claim.id = any(v_left_ids) or claim.id = any(v_right_ids);
  else
    v_status := 'dismissed';
  end if;

  update public.memory_conflicts c set
    status = case when p_resolution = 'dismiss' then 'dismissed' else 'resolved' end,
    resolution = case
      when p_resolution = 'dismiss' then 'dismiss'
      when p_resolution = 'keep_both' then 'keep_both'
      when c.left_claim_id = any(v_loser_ids) then 'keep_right'
      else 'keep_left'
    end,
    resolved_claim_id = case
      when p_resolution in ('keep_left', 'keep_right') then
        case when c.left_claim_id = any(v_loser_ids) then c.right_claim_id else c.left_claim_id end
      else null end,
    resolved_at = p_now,
    updated_at = p_now
  where c.workspace_id = p_workspace_id and c.status = 'unresolved'
    and ((c.left_claim_id = any(v_left_ids) and c.right_claim_id = any(v_right_ids))
      or (c.left_claim_id = any(v_right_ids) and c.right_claim_id = any(v_left_ids)));
  get diagnostics v_affected = row_count;

  if v_loser_ids is not null then
    update public.memory_conflicts c set
      status = 'resolved', resolution = 'superseded_elsewhere',
      resolved_claim_id = null, resolved_at = p_now, updated_at = p_now
    where c.workspace_id = p_workspace_id and c.status = 'unresolved'
      and (c.left_claim_id = any(v_loser_ids) or c.right_claim_id = any(v_loser_ids));
    get diagnostics v_additional = row_count;
    v_affected := v_affected + v_additional;
  end if;

  insert into public.diagnostic_events (workspace_id, provider, stage, status, request_id, detail)
  values (p_workspace_id, null, 'memory_conflict_resolved', 'ok', v_conflict.id::text,
    jsonb_build_object('conflictId', v_conflict.id, 'resolution', p_resolution,
      'actorUserId', p_actor_user_id, 'affectedConflicts', v_affected));

  return jsonb_build_object('conflictId', v_conflict.id, 'status', v_status,
    'resolution', p_resolution, 'resolvedClaimId', v_resolved_id,
    'affectedConflicts', v_affected,
    'affectedClaims', case when p_resolution = 'dismiss' then 0 else cardinality(v_left_ids) + cardinality(v_right_ids) end);
end;
$$;

revoke execute on function public.resolve_memory_conflict(uuid, uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.resolve_memory_conflict(uuid, uuid, text, uuid, timestamptz) to service_role;
