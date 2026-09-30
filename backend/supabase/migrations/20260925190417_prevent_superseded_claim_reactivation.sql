-- A conflict choice must not be undone by reviewing an older fact card.
-- Reconsidering a superseded claim requires an explicit conflict workflow.
create or replace function public.review_memory_claim(
  p_workspace_id uuid,
  p_claim_id uuid,
  p_decision text,
  p_actor_user_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim public.memory_claims%rowtype;
  v_new_status text;
  v_new_review text;
  v_new_authority text;
begin
  if p_decision not in ('yes', 'no', 'not_sure') then
    raise data_exception using message = 'invalid_claim_decision';
  end if;

  select * into v_claim
  from public.memory_claims
  where id = p_claim_id and workspace_id = p_workspace_id
  for update;
  if v_claim.id is null then
    raise no_data_found using message = 'memory_claim_not_found';
  end if;
  if v_claim.status in ('superseded', 'deleted') then
    raise data_exception using message = 'memory_claim_no_longer_reviewable';
  end if;

  v_new_status := case p_decision when 'yes' then 'confirmed' when 'no' then 'rejected' else 'provisional' end;
  v_new_review := p_decision;
  v_new_authority := case when p_decision = 'yes' then 'user_confirmed' else v_claim.authority end;

  insert into public.memory_claim_reviews (
    workspace_id, memory_claim_id, actor_user_id, decision,
    previous_status, new_status, previous_review_state, new_review_state
  ) values (
    p_workspace_id, v_claim.id, p_actor_user_id, p_decision,
    v_claim.status, v_new_status, v_claim.review_state, v_new_review
  );

  update public.memory_claims set
    status = v_new_status,
    review_state = v_new_review,
    authority = v_new_authority,
    reviewed_at = p_now,
    updated_at = p_now
  where id = v_claim.id;

  insert into public.diagnostic_events (workspace_id, provider, stage, status, request_id, detail)
  values (
    p_workspace_id, null, 'memory_claim_reviewed', 'ok', v_claim.id::text,
    jsonb_build_object('claimId', v_claim.id, 'decision', p_decision, 'actorUserId', p_actor_user_id)
  );

  return jsonb_build_object('claimId', v_claim.id, 'status', v_new_status, 'reviewState', v_new_review);
end;
$$;

revoke execute on function public.review_memory_claim(uuid, uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.review_memory_claim(uuid, uuid, text, uuid, timestamptz)
  to service_role;
