alter table public.summarization_jobs
  add column event_revisions jsonb not null default '{}'::jsonb,
  add column cached_input_tokens integer,
  add column total_tokens integer,
  add column exact_cost_usd numeric(14, 8),
  add constraint summarization_jobs_event_revisions_object
    check (jsonb_typeof(event_revisions) = 'object'),
  add constraint summarization_jobs_extended_usage_nonnegative check (
    (cached_input_tokens is null or cached_input_tokens >= 0) and
    (total_tokens is null or total_tokens >= 0) and
    (exact_cost_usd is null or exact_cost_usd >= 0)
  );

alter table public.checkpoints
  add column cached_input_tokens integer,
  add column total_tokens integer,
  add column exact_cost_usd numeric(14, 8),
  add constraint checkpoints_extended_usage_nonnegative check (
    (cached_input_tokens is null or cached_input_tokens >= 0) and
    (total_tokens is null or total_tokens >= 0) and
    (exact_cost_usd is null or exact_cost_usd >= 0)
  );

grant select on public.conversations, public.conversation_events, public.summarizer_secrets
  to service_role;
grant select, update on public.summarizer_settings
  to service_role;
grant select, insert, update on public.summarization_jobs, public.checkpoints
  to service_role;
grant select, insert on public.checkpoint_events
  to service_role;
grant select, insert on public.memory_claims
  to service_role;
grant insert on public.memory_evidence, public.diagnostic_events
  to service_role;
grant usage, select on sequence public.memory_evidence_id_seq, public.diagnostic_events_id_seq
  to service_role;

create or replace function public.enqueue_summarization_job(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_reason text,
  p_new_event_ids bigint[],
  p_overlap_event_ids bigint[],
  p_event_revisions jsonb,
  p_provider text,
  p_model text,
  p_prompt_version text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job_id uuid;
  v_all_event_ids bigint[];
  v_expected_count integer;
  v_matching_count integer;
begin
  if p_reason not in ('scheduled', 'manual', 'retry', 'backfill') then
    raise data_exception using message = 'invalid_job_reason';
  end if;
  if cardinality(p_new_event_ids) not between 1 and 100
    or cardinality(coalesce(p_overlap_event_ids, '{}'::bigint[])) > 20 then
    raise data_exception using message = 'invalid_job_event_count';
  end if;
  if jsonb_typeof(p_event_revisions) <> 'object' then
    raise data_exception using message = 'invalid_event_revisions';
  end if;
  if p_model is null or char_length(btrim(p_model)) not between 1 and 160 then
    raise data_exception using message = 'invalid_job_model';
  end if;
  if not exists (
    select 1 from public.conversations
    where id = p_conversation_id and workspace_id = p_workspace_id
  ) then
    raise insufficient_privilege using message = 'conversation_not_in_workspace';
  end if;
  if exists (
    select 1
    from unnest(p_new_event_ids) as new_events(event_id)
    join unnest(coalesce(p_overlap_event_ids, '{}'::bigint[])) as overlap_events(event_id)
      using (event_id)
  ) then
    raise data_exception using message = 'job_event_sets_overlap';
  end if;

  select coalesce(array_agg(distinct event_id), '{}'::bigint[])
  into v_all_event_ids
  from unnest(p_new_event_ids || coalesce(p_overlap_event_ids, '{}'::bigint[])) event_id;
  v_expected_count := cardinality(v_all_event_ids);

  select count(*)::integer into v_matching_count
  from public.conversation_events
  where workspace_id = p_workspace_id
    and conversation_id = p_conversation_id
    and id = any(v_all_event_ids)
    and revision = (p_event_revisions->>id::text)::integer;

  if v_matching_count <> v_expected_count then
    raise data_exception using message = 'job_source_snapshot_mismatch';
  end if;

  begin
    insert into public.summarization_jobs (
      workspace_id, conversation_id, reason, status, scheduled_for, eligible_after,
      new_event_ids, overlap_event_ids, event_revisions,
      first_new_event_id, last_new_event_id, provider, model, prompt_version
    ) values (
      p_workspace_id, p_conversation_id, p_reason, 'pending', p_now, p_now,
      p_new_event_ids, coalesce(p_overlap_event_ids, '{}'::bigint[]), p_event_revisions,
      p_new_event_ids[1], p_new_event_ids[cardinality(p_new_event_ids)],
      p_provider, btrim(p_model), p_prompt_version
    ) returning id into v_job_id;

    return jsonb_build_object('created', true, 'jobId', v_job_id);
  exception when unique_violation then
    select id into v_job_id
    from public.summarization_jobs
    where conversation_id = p_conversation_id and status in ('pending', 'processing')
    order by created_at
    limit 1;
    if p_reason = 'manual' then
      update public.summarization_jobs
      set eligible_after = least(eligible_after, p_now), updated_at = p_now
      where id = v_job_id and status = 'pending';
    end if;
    return jsonb_build_object('created', false, 'jobId', v_job_id);
  end;
end;
$$;

create or replace function public.claim_summarization_job(
  p_job_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.summarization_jobs%rowtype;
begin
  update public.summarization_jobs set
    status = 'processing',
    attempt_count = attempt_count + 1,
    claimed_at = p_now,
    error_code = null,
    error_detail = null,
    updated_at = p_now
  where id = p_job_id
    and status = 'pending'
    and eligible_after <= p_now
    and attempt_count < max_attempts
  returning * into v_job;

  if v_job.id is null then
    return null;
  end if;
  return to_jsonb(v_job);
end;
$$;

create or replace function public.complete_summarization_job(
  p_job_id uuid,
  p_output jsonb,
  p_usage jsonb,
  p_model_version text,
  p_provider_request_id text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.summarization_jobs%rowtype;
  v_previous_checkpoint public.checkpoints%rowtype;
  v_checkpoint_id uuid;
  v_version integer;
  v_all_event_ids bigint[];
  v_expected_count integer;
  v_matching_count integer;
  v_claim jsonb;
  v_claim_id uuid;
  v_evidence_id_text text;
  v_source_provider text;
begin
  select * into v_job
  from public.summarization_jobs
  where id = p_job_id
  for update;

  if v_job.id is null then
    raise no_data_found using message = 'summarization_job_not_found';
  end if;
  if v_job.status = 'completed' then
    select id into v_checkpoint_id from public.checkpoints where summarization_job_id = p_job_id;
    return jsonb_build_object('completed', true, 'idempotentReplay', true, 'checkpointId', v_checkpoint_id);
  end if;
  if v_job.status <> 'processing' then
    raise data_exception using message = 'summarization_job_not_processing';
  end if;
  if jsonb_typeof(p_output) <> 'object'
    or jsonb_typeof(p_output->'topics') <> 'array'
    or jsonb_typeof(p_output->'keyDecisions') <> 'array'
    or jsonb_typeof(p_output->'openThreads') <> 'array'
    or jsonb_typeof(p_output->'claims') <> 'array'
    or nullif(btrim(p_output->>'summary'), '') is null then
    raise data_exception using message = 'invalid_checkpoint_output';
  end if;

  select coalesce(array_agg(distinct event_id), '{}'::bigint[])
  into v_all_event_ids
  from unnest(v_job.new_event_ids || v_job.overlap_event_ids) event_id;
  v_expected_count := cardinality(v_all_event_ids);

  select count(*)::integer into v_matching_count
  from public.conversation_events
  where workspace_id = v_job.workspace_id
    and conversation_id = v_job.conversation_id
    and id = any(v_all_event_ids)
    and revision = (v_job.event_revisions->>id::text)::integer;

  if v_matching_count <> v_expected_count then
    update public.summarization_jobs set
      status = 'skipped',
      completed_at = p_now,
      error_code = 'source_revision_changed',
      error_detail = 'A source message changed before the checkpoint could be saved.',
      updated_at = p_now
    where id = p_job_id;
    return jsonb_build_object('completed', false, 'reason', 'source_revision_changed');
  end if;

  select * into v_previous_checkpoint
  from public.checkpoints
  where conversation_id = v_job.conversation_id
    and status in ('active', 'user_edited')
  order by version desc
  limit 1
  for update;

  select coalesce(max(version), 0) + 1 into v_version
  from public.checkpoints
  where conversation_id = v_job.conversation_id;

  update public.checkpoints set status = 'superseded', updated_at = p_now
  where conversation_id = v_job.conversation_id
    and status in ('active', 'user_edited');

  insert into public.checkpoints (
    workspace_id, conversation_id, summarization_job_id, previous_checkpoint_id, version,
    first_event_id, last_event_id, source_event_ids, summary_text, topics,
    open_threads, key_decisions, status, source_availability,
    provider, model, model_version, prompt_version,
    input_tokens, output_tokens, cached_input_tokens, total_tokens,
    estimated_cost_usd, exact_cost_usd
  ) values (
    v_job.workspace_id, v_job.conversation_id, v_job.id, v_previous_checkpoint.id, v_version,
    v_job.first_new_event_id, v_job.last_new_event_id, v_all_event_ids,
    p_output->>'summary',
    array(select jsonb_array_elements_text(p_output->'topics')),
    p_output->'openThreads', p_output->'keyDecisions', 'active', 'available',
    v_job.provider, v_job.model, p_model_version, v_job.prompt_version,
    nullif(p_usage->>'inputTokens', '')::integer,
    nullif(p_usage->>'outputTokens', '')::integer,
    nullif(p_usage->>'cachedInputTokens', '')::integer,
    nullif(p_usage->>'totalTokens', '')::integer,
    nullif(p_usage->>'estimatedCostUsd', '')::numeric,
    nullif(p_usage->>'exactCostUsd', '')::numeric
  ) returning id into v_checkpoint_id;

  insert into public.checkpoint_events (
    checkpoint_id, conversation_event_id, inclusion_type, position, included_revision
  )
  select v_checkpoint_id, event_id, inclusion_type, (ordinality - 1)::integer,
    (v_job.event_revisions->>event_id::text)::integer
  from (
    select event_id, 'new'::text as inclusion_type, ordinality
    from unnest(v_job.new_event_ids) with ordinality as new_events(event_id, ordinality)
    union all
    select event_id, 'overlap'::text as inclusion_type, ordinality
    from unnest(v_job.overlap_event_ids) with ordinality as overlap_events(event_id, ordinality)
  ) included;

  for v_claim in select value from jsonb_array_elements(p_output->'claims')
  loop
    if jsonb_typeof(v_claim->'evidenceEventIds') <> 'array'
      or jsonb_array_length(v_claim->'evidenceEventIds') < 1
      or exists (
        select 1
        from jsonb_array_elements_text(v_claim->'evidenceEventIds') evidence(value)
        where evidence.value::bigint <> all(v_all_event_ids)
      ) then
      raise data_exception using message = 'claim_evidence_outside_job';
    end if;
    insert into public.memory_claims (
      workspace_id, conversation_id, subject, predicate, value, display_text,
      scope_type, authority, status, review_state, confidence, observed_at,
      sensitivity, source_availability
    ) values (
      v_job.workspace_id, v_job.conversation_id, 'user', v_claim->>'predicate',
      to_jsonb(v_claim->>'value'), v_claim->>'displayText',
      'workspace', 'derived', 'provisional', 'unreviewed',
      (v_claim->>'confidence')::numeric,
      coalesce((
        select max(coalesce(message_timestamp, captured_at))
        from public.conversation_events
        where id = any(array(
          select value::bigint from jsonb_array_elements_text(v_claim->'evidenceEventIds')
        ))
      ), p_now),
      v_claim->>'sensitivity', 'available'
    ) returning id into v_claim_id;

    for v_evidence_id_text in select value from jsonb_array_elements_text(v_claim->'evidenceEventIds')
    loop
      insert into public.memory_evidence (
        workspace_id, memory_claim_id, conversation_event_id, evidence_role
      ) values (
        v_job.workspace_id, v_claim_id, v_evidence_id_text::bigint, 'supports'
      );
    end loop;
  end loop;

  update public.summarization_jobs set
    status = 'completed',
    completed_at = p_now,
    input_tokens = nullif(p_usage->>'inputTokens', '')::integer,
    output_tokens = nullif(p_usage->>'outputTokens', '')::integer,
    cached_input_tokens = nullif(p_usage->>'cachedInputTokens', '')::integer,
    total_tokens = nullif(p_usage->>'totalTokens', '')::integer,
    estimated_cost_usd = nullif(p_usage->>'estimatedCostUsd', '')::numeric,
    exact_cost_usd = nullif(p_usage->>'exactCostUsd', '')::numeric,
    provider_request_id = left(p_provider_request_id, 512),
    model_version = left(p_model_version, 160),
    error_code = null,
    error_detail = null,
    updated_at = p_now
  where id = p_job_id;

  select provider into v_source_provider
  from public.conversations where id = v_job.conversation_id;

  insert into public.diagnostic_events (workspace_id, provider, stage, status, request_id, detail)
  values (
    v_job.workspace_id, v_source_provider, 'summarization_complete', 'ok',
    coalesce(left(p_provider_request_id, 512), v_job.id::text),
    jsonb_build_object(
      'jobId', v_job.id,
      'conversationId', v_job.conversation_id,
      'checkpointId', v_checkpoint_id,
      'newEventCount', cardinality(v_job.new_event_ids),
      'overlapEventCount', cardinality(v_job.overlap_event_ids),
      'provider', v_job.provider,
      'model', v_job.model,
      'inputTokens', nullif(p_usage->>'inputTokens', '')::integer,
      'outputTokens', nullif(p_usage->>'outputTokens', '')::integer,
      'exactCostUsd', nullif(p_usage->>'exactCostUsd', '')::numeric
    )
  );

  return jsonb_build_object(
    'completed', true,
    'idempotentReplay', false,
    'checkpointId', v_checkpoint_id,
    'version', v_version,
    'claimCount', jsonb_array_length(p_output->'claims')
  );
end;
$$;

create or replace function public.fail_summarization_job(
  p_job_id uuid,
  p_retryable boolean,
  p_error_code text,
  p_error_detail text,
  p_skip boolean default false,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.summarization_jobs%rowtype;
  v_next_status text;
  v_next_eligible timestamptz;
  v_source_provider text;
begin
  select * into v_job
  from public.summarization_jobs
  where id = p_job_id
  for update;

  if v_job.id is null then
    raise no_data_found using message = 'summarization_job_not_found';
  end if;
  if v_job.status <> 'processing' then
    return jsonb_build_object('status', v_job.status, 'retryScheduled', v_job.status = 'pending');
  end if;

  if p_skip then
    v_next_status := 'skipped';
    v_next_eligible := v_job.eligible_after;
  elsif p_retryable and v_job.attempt_count < v_job.max_attempts then
    v_next_status := 'pending';
    v_next_eligible := p_now + make_interval(secs => least(900, 30 * power(2, greatest(0, v_job.attempt_count - 1)))::integer);
  else
    v_next_status := 'failed';
    v_next_eligible := v_job.eligible_after;
  end if;

  update public.summarization_jobs set
    status = v_next_status,
    eligible_after = v_next_eligible,
    completed_at = case when v_next_status in ('failed', 'skipped') then p_now else null end,
    error_code = left(coalesce(nullif(p_error_code, ''), 'summarization_failed'), 120),
    error_detail = left(coalesce(nullif(p_error_detail, ''), 'The summary could not be completed.'), 1000),
    updated_at = p_now
  where id = p_job_id;

  select provider into v_source_provider
  from public.conversations where id = v_job.conversation_id;

  insert into public.diagnostic_events (workspace_id, provider, stage, status, request_id, detail)
  values (
    v_job.workspace_id, v_source_provider, 'summarization_failed',
    case when v_next_status = 'pending' then 'warning' else 'error' end,
    v_job.id::text,
    jsonb_build_object(
      'jobId', v_job.id,
      'conversationId', v_job.conversation_id,
      'errorCode', left(coalesce(nullif(p_error_code, ''), 'summarization_failed'), 120),
      'attemptCount', v_job.attempt_count,
      'maxAttempts', v_job.max_attempts,
      'retryScheduled', v_next_status = 'pending',
      'nextEligibleAt', case when v_next_status = 'pending' then v_next_eligible else null end
    )
  );

  return jsonb_build_object(
    'status', v_next_status,
    'retryScheduled', v_next_status = 'pending',
    'nextEligibleAt', case when v_next_status = 'pending' then v_next_eligible else null end
  );
end;
$$;

revoke execute on function public.enqueue_summarization_job(uuid, uuid, text, bigint[], bigint[], jsonb, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.claim_summarization_job(uuid, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.complete_summarization_job(uuid, jsonb, jsonb, text, text, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.fail_summarization_job(uuid, boolean, text, text, boolean, timestamptz)
  from public, anon, authenticated;

grant execute on function public.enqueue_summarization_job(uuid, uuid, text, bigint[], bigint[], jsonb, text, text, text, timestamptz)
  to service_role;
grant execute on function public.claim_summarization_job(uuid, timestamptz)
  to service_role;
grant execute on function public.complete_summarization_job(uuid, jsonb, jsonb, text, text, timestamptz)
  to service_role;
grant execute on function public.fail_summarization_job(uuid, boolean, text, text, boolean, timestamptz)
  to service_role;
