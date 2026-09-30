alter table public.memory_claims
  add column origin_checkpoint_id uuid references public.checkpoints(id) on delete set null;

create index memory_claims_origin_checkpoint_idx
  on public.memory_claims (origin_checkpoint_id);

create table public.memory_claim_reviews (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  memory_claim_id uuid not null references public.memory_claims(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  decision text not null,
  previous_status text not null,
  new_status text not null,
  previous_review_state text not null,
  new_review_state text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint memory_claim_reviews_decision_allowed check (
    decision in ('yes', 'no', 'not_sure', 'conflict_keep_left', 'conflict_keep_right', 'conflict_keep_both')
  )
);

create index memory_claim_reviews_claim_created_idx
  on public.memory_claim_reviews (memory_claim_id, created_at desc);
create index memory_claim_reviews_workspace_created_idx
  on public.memory_claim_reviews (workspace_id, created_at desc);
create index memory_claim_reviews_actor_user_idx
  on public.memory_claim_reviews (actor_user_id);

alter table public.memory_claim_reviews enable row level security;
alter table public.memory_claim_reviews force row level security;

create policy memory_claim_reviews_select_owned_workspace on public.memory_claim_reviews
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = memory_claim_reviews.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

revoke all on public.memory_claim_reviews from anon, authenticated;
grant select on public.memory_claim_reviews to authenticated;
grant select, insert on public.memory_claim_reviews to service_role;
grant usage, select on sequence public.memory_claim_reviews_id_seq to service_role;
grant update on public.memory_claims, public.memory_conflicts, public.checkpoints to service_role;
grant insert on public.checkpoints, public.checkpoint_events, public.memory_conflicts to service_role;

create or replace function public.attach_claim_lineage_and_conflicts()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.origin_checkpoint_id is null and new.conversation_id is not null then
    select id into new.origin_checkpoint_id
    from public.checkpoints
    where conversation_id = new.conversation_id
      and status in ('active', 'user_edited')
    order by version desc
    limit 1;
  end if;
  return new;
end;
$$;

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

  insert into public.memory_conflicts (
    workspace_id, left_claim_id, right_claim_id, status
  )
  select new.workspace_id, existing.id, new.id, 'unresolved'
  from public.memory_claims existing
  where existing.workspace_id = new.workspace_id
    and existing.id <> new.id
    and existing.predicate = new.predicate
    and existing.scope_type = new.scope_type
    and coalesce(existing.scope_ref, '') = coalesce(new.scope_ref, '')
    and existing.value <> new.value
    and existing.status in ('provisional', 'confirmed')
  on conflict do nothing;

  return new;
end;
$$;

create trigger memory_claims_attach_lineage_before_insert
before insert on public.memory_claims
for each row execute function public.attach_claim_lineage_and_conflicts();

create trigger memory_claims_create_conflicts_after_insert
after insert on public.memory_claims
for each row execute function public.create_claim_evidence_and_conflicts();

create or replace function public.edit_checkpoint_summary(
  p_workspace_id uuid,
  p_checkpoint_id uuid,
  p_summary_text text,
  p_actor_user_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old public.checkpoints%rowtype;
  v_new_id uuid;
  v_version integer;
  v_source_provider text;
begin
  if nullif(btrim(p_summary_text), '') is null or char_length(p_summary_text) > 30000 then
    raise data_exception using message = 'invalid_summary_text';
  end if;

  select * into v_old
  from public.checkpoints
  where id = p_checkpoint_id and workspace_id = p_workspace_id
  for update;

  if v_old.id is null then
    raise no_data_found using message = 'checkpoint_not_found';
  end if;
  if v_old.status not in ('active', 'user_edited') then
    raise data_exception using message = 'checkpoint_not_editable';
  end if;

  select coalesce(max(version), 0) + 1 into v_version
  from public.checkpoints
  where conversation_id = v_old.conversation_id;

  update public.checkpoints set status = 'superseded', updated_at = p_now
  where conversation_id = v_old.conversation_id
    and status in ('active', 'user_edited');

  insert into public.checkpoints (
    workspace_id, conversation_id, previous_checkpoint_id, version,
    first_event_id, last_event_id, source_event_ids, summary_text, topics,
    open_threads, key_decisions, status, source_availability,
    provider, model, model_version, prompt_version,
    input_tokens, output_tokens, cached_input_tokens, total_tokens,
    estimated_cost_usd, exact_cost_usd, edited_at, created_at, updated_at
  ) values (
    v_old.workspace_id, v_old.conversation_id, v_old.id, v_version,
    v_old.first_event_id, v_old.last_event_id, v_old.source_event_ids, btrim(p_summary_text), v_old.topics,
    v_old.open_threads, v_old.key_decisions, 'user_edited', v_old.source_availability,
    v_old.provider, v_old.model, v_old.model_version, v_old.prompt_version,
    v_old.input_tokens, v_old.output_tokens, v_old.cached_input_tokens, v_old.total_tokens,
    v_old.estimated_cost_usd, v_old.exact_cost_usd, p_now, p_now, p_now
  ) returning id into v_new_id;

  insert into public.checkpoint_events (
    checkpoint_id, conversation_event_id, inclusion_type, position, included_revision
  )
  select v_new_id, conversation_event_id, inclusion_type, position, included_revision
  from public.checkpoint_events
  where checkpoint_id = v_old.id;

  select provider into v_source_provider
  from public.conversations where id = v_old.conversation_id;
  insert into public.diagnostic_events (workspace_id, provider, stage, status, request_id, detail)
  values (
    p_workspace_id, v_source_provider, 'summary_edited', 'ok', v_new_id::text,
    jsonb_build_object(
      'checkpointId', v_new_id,
      'previousCheckpointId', v_old.id,
      'conversationId', v_old.conversation_id,
      'version', v_version,
      'actorUserId', p_actor_user_id
    )
  );

  return jsonb_build_object('checkpointId', v_new_id, 'version', v_version, 'status', 'user_edited');
end;
$$;

create or replace function public.delete_checkpoint_summary(
  p_workspace_id uuid,
  p_checkpoint_id uuid,
  p_actor_user_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_checkpoint public.checkpoints%rowtype;
  v_source_provider text;
begin
  select * into v_checkpoint
  from public.checkpoints
  where id = p_checkpoint_id and workspace_id = p_workspace_id
  for update;

  if v_checkpoint.id is null then
    raise no_data_found using message = 'checkpoint_not_found';
  end if;
  if v_checkpoint.status not in ('active', 'user_edited') then
    raise data_exception using message = 'checkpoint_not_deletable';
  end if;

  update public.checkpoints set
    summary_text = '[Deleted by user]',
    topics = '{}'::text[],
    open_threads = '[]'::jsonb,
    key_decisions = '[]'::jsonb,
    status = 'deleted',
    updated_at = p_now
  where id = v_checkpoint.id;

  select provider into v_source_provider
  from public.conversations where id = v_checkpoint.conversation_id;
  insert into public.diagnostic_events (workspace_id, provider, stage, status, request_id, detail)
  values (
    p_workspace_id, v_source_provider, 'summary_deleted', 'ok', v_checkpoint.id::text,
    jsonb_build_object(
      'checkpointId', v_checkpoint.id,
      'conversationId', v_checkpoint.conversation_id,
      'version', v_checkpoint.version,
      'actorUserId', p_actor_user_id,
      'claimsRetainedForReview', true
    )
  );

  return jsonb_build_object('checkpointId', v_checkpoint.id, 'status', 'deleted');
end;
$$;

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
  v_resolved_id uuid;
  v_status text := 'resolved';
begin
  if p_resolution not in ('keep_left', 'keep_right', 'keep_both', 'dismiss') then
    raise data_exception using message = 'invalid_conflict_resolution';
  end if;

  select * into v_conflict
  from public.memory_conflicts
  where id = p_conflict_id and workspace_id = p_workspace_id
  for update;
  if v_conflict.id is null then
    raise no_data_found using message = 'memory_conflict_not_found';
  end if;
  if v_conflict.status <> 'unresolved' then
    return jsonb_build_object('conflictId', v_conflict.id, 'status', v_conflict.status, 'idempotentReplay', true);
  end if;

  select * into v_left from public.memory_claims where id = v_conflict.left_claim_id for update;
  select * into v_right from public.memory_claims where id = v_conflict.right_claim_id for update;

  if p_resolution = 'keep_left' then
    update public.memory_claims set status='confirmed', review_state='yes', authority='user_confirmed', reviewed_at=p_now, updated_at=p_now where id=v_left.id;
    update public.memory_claims set status='superseded', review_state='no', reviewed_at=p_now, updated_at=p_now where id=v_right.id;
    v_resolved_id := v_left.id;
  elsif p_resolution = 'keep_right' then
    update public.memory_claims set status='superseded', review_state='no', reviewed_at=p_now, updated_at=p_now where id=v_left.id;
    update public.memory_claims set status='confirmed', review_state='yes', authority='user_confirmed', reviewed_at=p_now, updated_at=p_now where id=v_right.id;
    v_resolved_id := v_right.id;
  elsif p_resolution = 'keep_both' then
    update public.memory_claims set status='confirmed', review_state='yes', authority='user_confirmed', reviewed_at=p_now, updated_at=p_now where id in (v_left.id, v_right.id);
  else
    v_status := 'dismissed';
  end if;

  if p_resolution <> 'dismiss' then
    insert into public.memory_claim_reviews (
      workspace_id, memory_claim_id, actor_user_id, decision,
      previous_status, new_status, previous_review_state, new_review_state,
      detail
    ) values
      (p_workspace_id, v_left.id, p_actor_user_id, 'conflict_' || p_resolution,
        v_left.status,
        case p_resolution when 'keep_right' then 'superseded' else 'confirmed' end,
        v_left.review_state,
        case p_resolution when 'keep_right' then 'no' else 'yes' end,
        jsonb_build_object('conflictId', v_conflict.id)),
      (p_workspace_id, v_right.id, p_actor_user_id, 'conflict_' || p_resolution,
        v_right.status,
        case p_resolution when 'keep_left' then 'superseded' else 'confirmed' end,
        v_right.review_state,
        case p_resolution when 'keep_left' then 'no' else 'yes' end,
        jsonb_build_object('conflictId', v_conflict.id));
  end if;

  update public.memory_conflicts set
    status = v_status,
    resolution = p_resolution,
    resolved_claim_id = v_resolved_id,
    resolved_at = p_now,
    updated_at = p_now
  where id = v_conflict.id;

  insert into public.diagnostic_events (workspace_id, provider, stage, status, request_id, detail)
  values (
    p_workspace_id, null, 'memory_conflict_resolved', 'ok', v_conflict.id::text,
    jsonb_build_object('conflictId', v_conflict.id, 'resolution', p_resolution, 'actorUserId', p_actor_user_id)
  );

  return jsonb_build_object('conflictId', v_conflict.id, 'status', v_status, 'resolution', p_resolution, 'resolvedClaimId', v_resolved_id);
end;
$$;

revoke execute on function public.edit_checkpoint_summary(uuid, uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.delete_checkpoint_summary(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.review_memory_claim(uuid, uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.resolve_memory_conflict(uuid, uuid, text, uuid, timestamptz)
  from public, anon, authenticated;

grant execute on function public.edit_checkpoint_summary(uuid, uuid, text, uuid, timestamptz) to service_role;
grant execute on function public.delete_checkpoint_summary(uuid, uuid, uuid, timestamptz) to service_role;
grant execute on function public.review_memory_claim(uuid, uuid, text, uuid, timestamptz) to service_role;
grant execute on function public.resolve_memory_conflict(uuid, uuid, text, uuid, timestamptz) to service_role;
