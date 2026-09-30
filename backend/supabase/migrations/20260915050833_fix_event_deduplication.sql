alter table public.conversation_events
  drop constraint if exists conversation_events_workspace_conversation_sequence_role_unique;

do $migration$
declare
  v_definition text;
  v_old_match text := E'and (\n        event_key = v_event_key\n        or (v_provider_message_id is not null and provider_message_id = v_provider_message_id)\n        or (sequence = v_sequence and role = v_role)\n      )';
  v_new_match text := E'and (\n        event_key = v_event_key\n        or (v_provider_message_id is not null and provider_message_id = v_provider_message_id)\n      )';
  v_old_order text := E'case when event_key = v_event_key then 0\n           when v_provider_message_id is not null and provider_message_id = v_provider_message_id then 1\n           else 2 end';
  v_new_order text := E'case when event_key = v_event_key then 0\n           else 1 end';
begin
  select pg_get_functiondef(
    'public.ingest_capture_batch(uuid,uuid,uuid,text,text,text,text,bigint,jsonb,jsonb)'::regprocedure
  ) into v_definition;

  if strpos(v_definition, v_old_match) > 0 and strpos(v_definition, v_old_order) > 0 then
    v_definition := replace(v_definition, v_old_match, v_new_match);
    v_definition := replace(v_definition, v_old_order, v_new_order);
    execute v_definition;
  elsif strpos(v_definition, v_new_match) = 0 or strpos(v_definition, v_new_order) = 0 then
    raise exception 'ingest_capture_batch definition did not match a supported Gate 5 version';
  end if;
end;
$migration$;
