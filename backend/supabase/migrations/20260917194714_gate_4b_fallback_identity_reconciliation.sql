-- Capture adapters sometimes have no durable provider message ID. When an
-- adapter improves from an unstable DOM identifier to the deterministic
-- sequence/role fallback, migrate the one unambiguous existing row instead of
-- leaving a duplicate or losing the corrected event.
do $migration$
declare
  v_definition text;
  v_declaration_anchor text := '  v_conversation_id uuid;';
  v_declaration_replacement text := $declarations$  v_conversation_id uuid;
  v_fallback_identity_candidate_id bigint;
  v_fallback_identity_candidate_count integer;
$declarations$;
  v_call_anchor text := $anchor$  v_result := public.ingest_capture_batch(
$anchor$;
  v_reconciliation text := $reconciliation$  for v_event in select value from jsonb_array_elements(p_events)
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

  v_result := public.ingest_capture_batch(
$reconciliation$;
begin
  select pg_get_functiondef(
    'public.ingest_capture_batch_v2(uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into v_definition;

  if strpos(v_definition, 'v_fallback_identity_candidate_count') > 0 then
    return;
  end if;
  if strpos(v_definition, v_declaration_anchor) = 0
    or strpos(v_definition, v_call_anchor) = 0 then
    raise exception 'ingest_capture_batch_v2 did not match the expected Capture API v2 definition';
  end if;

  v_definition := replace(v_definition, v_declaration_anchor, v_declaration_replacement);
  v_definition := replace(v_definition, v_call_anchor, v_reconciliation);
  execute v_definition;
end;
$migration$;
