-- Distinct message identifiers must not be merged solely by observed position.
-- Existing event-key/provider-ID updates remain in ingest_capture_batch.
do $migration$
declare
  v_definition text;
  v_unsafe_block text := $unsafe$  for v_event in select value from jsonb_array_elements(p_events)
  loop
    if nullif(btrim(v_event->>'providerMessageId'), '') is null
      and not exists (
        select 1
        from public.conversation_events existing
        where existing.workspace_id = p_workspace_id
          and existing.provider = p_product
          and existing.provider_conversation_id = btrim(v_event->>'conversationId')
          and existing.event_key = btrim(v_event->>'eventId')
      ) then
      select count(*), min(existing.id)
      into v_fallback_identity_candidate_count, v_fallback_identity_candidate_id
      from public.conversation_events existing
      where existing.workspace_id = p_workspace_id
        and existing.provider = p_product
        and existing.provider_conversation_id = btrim(v_event->>'conversationId')
        and existing.sequence = (v_event->>'sequence')::integer
        and existing.role = btrim(v_event->>'role')
        and existing.event_key <> btrim(v_event->>'eventId');

      if v_fallback_identity_candidate_count = 1 then
        update public.conversation_events
        set event_key = btrim(v_event->>'eventId'),
            provider_message_id = null,
            updated_at = now()
        where id = v_fallback_identity_candidate_id;
      end if;
    end if;
  end loop;

$unsafe$;
begin
  select pg_get_functiondef(
    'public.ingest_capture_batch_v2(uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into v_definition;
  if strpos(v_definition, 'if v_fallback_identity_candidate_count = 1 then') = 0 then
    return; -- Already applied; no grants, ownership or data are changed.
  end if;
  if strpos(v_definition, v_unsafe_block) = 0 then
    raise exception 'ingest_capture_batch_v2 does not match the reviewed fallback block';
  end if;
  execute replace(v_definition, v_unsafe_block, '');
end;
$migration$;
