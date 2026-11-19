-- Desktop products use the same chat-only deletion lifecycle as web products.
alter table public.deleted_conversations drop constraint deleted_conversations_provider_allowed;
alter table public.deleted_conversations add constraint deleted_conversations_provider_allowed
  check (provider in ('chatgpt','codex','claude','claude_code','gemini','antigravity'));

grant select, update on public.deleted_conversations to service_role;
grant select, update, delete on public.ingestion_batches to service_role;
grant select on public.conversation_events to service_role;

-- One bounded archive operation replaces per-object network metadata calls.
-- Only successful old-key results advance the matching operation's remaining set.
create function public.finish_chat_archive_chunk(
  p_workspace_id uuid, p_provider text, p_source_id text,
  p_operation_id uuid, p_results jsonb
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  pending_record public.deleted_conversations%rowtype;
  item jsonb;
  object_key text;
  remaining text[];
begin
  if jsonb_typeof(p_results) is distinct from 'array' or jsonb_array_length(p_results)>100 then
    raise exception 'invalid_archive_chunk';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_workspace_id::text || ':' || p_provider || ':' || p_source_id,0));
  select * into pending_record from public.deleted_conversations
    where workspace_id=p_workspace_id and provider=p_provider and provider_conversation_id=p_source_id
    for update;
  if not found or pending_record.operation_id is distinct from p_operation_id then
    return jsonb_build_object('pending',true,'stale',true);
  end if;
  if pending_record.archive_reconciled_at is not null then
    return jsonb_build_object('pending',false);
  end if;
  if pending_record.archive_cleanup_keys is null then
    raise exception 'archive_keys_not_frozen';
  end if;
  for item in select value from jsonb_array_elements(p_results) loop
    object_key := item->>'key';
    -- A duplicate completion is harmless and cannot reapply older index values.
    if object_key=any(pending_record.archive_cleanup_keys) then
      if item->>'deleted'='true' or item->>'missing'='true' then
        delete from public.ingestion_batches b
          where b.workspace_id=p_workspace_id and b.raw_object_key=object_key
            and (item->>'deleted'='true' or not exists (
              select 1 from public.conversation_events e
              where e.workspace_id=p_workspace_id and e.raw_object_key=object_key));
      elsif item->>'unchanged' is distinct from 'true' then
        if coalesce(item->>'sha256','') !~ '^[0-9a-f]{64}$'
          or jsonb_typeof(item->'providerConversationIds') is distinct from 'array'
          or (item->>'bytes')::bigint < 0 then
          raise exception 'invalid_archive_result';
        end if;
        update public.ingestion_batches set payload_sha256=item->>'sha256',
          payload_bytes=(item->>'bytes')::bigint,
          provider_conversation_ids=array(select jsonb_array_elements_text(item->'providerConversationIds'))
          where workspace_id=p_workspace_id and raw_object_key=object_key;
      end if;
    end if;
  end loop;
  remaining := array(select key from unnest(pending_record.archive_cleanup_keys) as old_keys(key)
    where not exists(select 1 from jsonb_array_elements(p_results) as done(value) where done.value->>'key'=key));
  update public.deleted_conversations set archive_cleanup_keys=remaining,
    archive_reconciled_at=case when cardinality(remaining)=0 then now() else null end
    where id=pending_record.id and operation_id=p_operation_id;
  return jsonb_build_object('pending',cardinality(remaining)>0,'remaining',cardinality(remaining));
end;
$$;
revoke all on function public.finish_chat_archive_chunk(uuid,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.finish_chat_archive_chunk(uuid,text,text,uuid,jsonb) to service_role;
comment on column public.deleted_conversations.archive_cleanup_keys is
  'Remaining subset of the frozen old archive keys. Chunk completion only removes keys for the matching operation; never discovers new recaptured copies.';
