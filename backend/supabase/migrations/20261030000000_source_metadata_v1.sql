-- Additive source evidence and title-only transactions. No existing rows are
-- reclassified, rekeyed, merged or backfilled. Shared writes gain evidence-aware guards.
alter table public.conversation_events add column source_metadata jsonb;
alter table public.conversations add column source_metadata jsonb,
  add column source_metadata_observed_at timestamptz,
  add column source_metadata_device_key text;
alter table public.ingestion_batches add column metadata_updated_count integer not null default 0,
 add column metadata_received_count integer not null default 0;

create function public.valid_source_metadata_v1(m jsonb) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(jsonb_typeof(m)='object'
  and m - array['version','titleBasis','conversationIdentity','messageIdentity','timestampBasis','linksStatus','attachmentsStatus']::text[] = '{}'::jsonb
  and m->'version'='1'::jsonb
  and m->>'titleBasis' in ('source','derived','generic','user','unknown')
  and m->>'conversationIdentity' in ('provider','local','unknown')
  and m->>'messageIdentity' in ('provider','local','unknown')
  and m->>'timestampBasis' in ('source','session_fallback','observed','unknown')
  and m->>'linksStatus' in ('inspected','unavailable','not_inspected','unknown')
  and m->>'attachmentsStatus' in ('inspected','unavailable','not_inspected','unknown'), false)
$$;
alter table public.conversation_events add constraint conversation_events_source_metadata_valid check (
 source_metadata is null or (public.valid_source_metadata_v1(source_metadata)
  and (source_metadata->>'messageIdentity'<>'provider' or nullif(btrim(provider_message_id),'') is not null)
  and (source_metadata->>'timestampBasis' not in ('source','session_fallback') or message_timestamp is not null)
  and (source_metadata->>'timestampBasis'<>'observed' or message_timestamp is null)
  and (capture_evidence is null or (source_metadata->>'conversationIdentity'='local'
    and source_metadata->>'messageIdentity'='local' and source_metadata->>'timestampBasis'='observed'
    and source_metadata->>'titleBasis'=case capture_evidence->>'titleBasis' when 'placeholder' then 'generic' else capture_evidence->>'titleBasis' end)))
);
alter table public.conversations add constraint conversations_source_metadata_valid check (
 source_metadata is null or public.valid_source_metadata_v1(source_metadata));

-- Preserve both previously deployed and historical Android evidence constraints,
-- widening only the title classification. All other checks remain byte-identical.
do $$ declare c record; definition text;
begin
 for c in select conname,pg_get_constraintdef(oid) as definition from pg_catalog.pg_constraint
 where conrelid='public.conversation_events'::regclass and conname in ('conversation_events_capture_evidence_valid','conversation_events_mobile_observation_valid') loop
  definition:=replace(c.definition, '= ''placeholder''::text', '= ANY (ARRAY[''placeholder''::text, ''source''::text, ''derived''::text])');
  execute format('alter table public.conversation_events drop constraint %I',c.conname);
  execute format('alter table public.conversation_events add constraint %I %s',c.conname,definition);
 end loop;
end $$;

-- All entry points, including immutable legacy requests, share these writes.
-- A classified title is updated only by the evidence transaction below, which
-- commits its title, basis and observation watermark together. Provider-message
-- fallback is allowed only for two provider-classified observations, or two
-- legacy observations whose old behavior must remain unchanged.
do $source_metadata_ingestion$
declare
 definition text;
 old_match text := 'or (v_provider_message_id is not null and provider_message_id = v_provider_message_id)';
 new_match text := $match$or (v_provider_message_id is not null and provider_message_id = v_provider_message_id
          and ((not (v_event ? 'sourceMetadata') and source_metadata is null)
            or (v_event->'sourceMetadata'->>'messageIdentity' = 'provider'
              and source_metadata->>'messageIdentity' = 'provider')))$match$;
 old_insert_columns text := E'captured_at, first_captured_at, last_captured_at, raw_object_key\n      ) values (';
 new_insert_columns text := E'captured_at, first_captured_at, last_captured_at, raw_object_key, source_metadata\n      ) values (';
 old_insert_values text := 'v_message_timestamp, v_captured_at, v_captured_at, v_captured_at, p_raw_object_key';
 new_insert_values text := 'v_message_timestamp, v_captured_at, v_captured_at, v_captured_at, p_raw_object_key, v_event->''sourceMetadata''';
 old_title text := 'title = excluded.title,';
 new_title text := 'title = case when public.conversations.source_metadata is null then excluded.title else public.conversations.title end,';
 old_revision text := 'message_timestamp = coalesce(v_message_timestamp, message_timestamp),';
 new_revision text := $revision$message_timestamp = coalesce(v_message_timestamp, message_timestamp),
        source_metadata = coalesce(v_event->'sourceMetadata', source_metadata),
        capture_evidence = coalesce(v_event->'captureEvidence', capture_evidence),$revision$;
begin
 select pg_get_functiondef('public.ingest_capture_batch(uuid,uuid,uuid,text,text,text,text,bigint,jsonb,jsonb)'::regprocedure) into definition;
 if strpos(definition,old_match)=0 or strpos(definition,old_title)=0 or strpos(definition,old_revision)=0 or strpos(definition,old_insert_columns)=0 or strpos(definition,old_insert_values)=0 then
  raise exception 'source_metadata_ingestion_anchor_mismatch'; end if;
 definition:=replace(replace(definition,old_insert_columns,new_insert_columns),old_insert_values,new_insert_values);
 execute replace(replace(replace(definition,old_match,new_match),old_title,new_title),old_revision,new_revision);
end $source_metadata_ingestion$;

-- Only provider-classified IDs and legacy IDs retain provider uniqueness.
-- Explicit local/unknown values remain stored verbatim but cannot identify a
-- message across devices; their distinct event keys remain distinct rows.
drop index public.conversation_events_provider_message_unique_idx;
create unique index conversation_events_provider_message_unique_idx
 on public.conversation_events(workspace_id,provider,provider_conversation_id,provider_message_id)
 where provider_message_id is not null and (source_metadata is null or source_metadata->>'messageIdentity'='provider');

create function public.ingest_capture_batch_v2_source_metadata(
 p_user_id uuid,p_workspace_id uuid,p_batch_id uuid,p_provider text,
 p_provider_family text,p_product text,p_surface text,p_reason text,
 p_raw_object_key text,p_payload_sha256 text,p_payload_bytes bigint,
 p_redaction_summary jsonb,p_capture_client jsonb,p_coverage jsonb,p_events jsonb,
 p_conversation_updates jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 receipt public.ingestion_batches%rowtype; result jsonb; item jsonb; m jsonb;
 existing public.conversations%rowtype; stored_event public.conversation_events%rowtype; event_list jsonb:='[]'::jsonb;
 changed integer:=0; affected integer; identity_basis text;
begin
 if p_user_id is null or not exists(select 1 from public.workspaces where id=p_workspace_id and owner_user_id=p_user_id) then
  raise insufficient_privilege using message='workspace_not_owned'; end if;
 if p_provider is distinct from p_product or p_product not in ('chatgpt','codex','claude','claude_code','gemini','antigravity')
  or p_provider_family is distinct from (case when p_product in ('chatgpt','codex') then 'openai' when p_product in ('claude','claude_code') then 'anthropic' else 'google' end)
  or p_surface not in ('web','desktop','cli','ide','android')
  or nullif(btrim(p_capture_client->>'deviceId'),'') is null then raise exception 'invalid_capture_provenance'; end if;
 if jsonb_typeof(p_events) is distinct from 'array' or jsonb_typeof(p_conversation_updates) is distinct from 'array'
  or jsonb_array_length(p_events)>100 or jsonb_array_length(p_conversation_updates)>100
  or jsonb_array_length(p_events)+jsonb_array_length(p_conversation_updates)=0 then raise exception 'invalid_event_count'; end if;
 if p_raw_object_key not like concat(p_workspace_id::text,'/',p_provider,'/%/',p_batch_id::text,'.json') then raise exception 'invalid_raw_object_key'; end if;
 -- Serialize wrappers using this immutable batch identity before invoking v2;
 -- a completed replay must not update adapter/event/conversation timestamps.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||':batch:'||p_batch_id::text,0));
 select * into receipt from public.ingestion_batches where workspace_id=p_workspace_id and batch_id=p_batch_id;
 if found then
  if receipt.payload_sha256 is distinct from p_payload_sha256 then raise exception 'idempotency_payload_mismatch'; end if;
  return jsonb_build_object('idempotentReplay',true,'status',receipt.status,'received',receipt.received_count,
   'inserted',receipt.inserted_count,'updated',receipt.updated_count,'duplicates',receipt.duplicate_count,'metadataUpdated',receipt.metadata_updated_count,'metadataReceived',receipt.metadata_received_count);
 end if;
 for item in select value from jsonb_array_elements(p_events) loop
  m:=item->'sourceMetadata';
  if m is not null and not public.valid_source_metadata_v1(m) then raise exception 'invalid_source_metadata'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||':'||p_product||':'||(item->>'conversationId'),0));
  select * into existing from public.conversations where workspace_id=p_workspace_id and provider=p_product and provider_conversation_id=item->>'conversationId' for update;
  if found and m is not null and existing.source_metadata is not null and
   (existing.source_metadata->>'conversationIdentity' is distinct from m->>'conversationIdentity'
    or (m->>'conversationIdentity'='local' and existing.source_metadata_device_key is distinct from p_capture_client->>'deviceId')) then
   raise exception 'source_metadata_identity_conflict'; end if;
  if existing.source_metadata_observed_at > (item->>'capturedAt')::timestamptz then
   item:=jsonb_set(item,'{chatTitle}',to_jsonb(existing.title)); end if;
  if m is not null then
   select * into stored_event from public.conversation_events where workspace_id=p_workspace_id and provider=p_product
    and provider_conversation_id=item->>'conversationId' and (event_key=item->>'eventId'
     or (m->>'messageIdentity'='provider' and source_metadata->>'messageIdentity'='provider'
      and nullif(item->>'providerMessageId','') is not null and provider_message_id=item->>'providerMessageId'))
    order by case when event_key=item->>'eventId' then 0 else 1 end limit 1 for update;
   if found and stored_event.message_timestamp is not null and (stored_event.source_metadata->>'timestampBasis'='source' and m->>'timestampBasis'<>'source'
     or item->>'messageTimestamp' is null) then
    item:=jsonb_set(item,'{messageTimestamp}',to_jsonb(stored_event.message_timestamp));
    m:=jsonb_set(m,'{timestampBasis}',to_jsonb(coalesce(stored_event.source_metadata->>'timestampBasis','unknown')));
    item:=jsonb_set(item,'{sourceMetadata}',m);
   end if;
  end if;
  event_list:=event_list||jsonb_build_array(item);
 end loop;
 if jsonb_array_length(p_events)>0 then
  result:=public.ingest_capture_batch_v2(p_user_id,p_workspace_id,p_batch_id,p_provider,p_provider_family,p_product,p_surface,p_reason,p_raw_object_key,p_payload_sha256,p_payload_bytes,p_redaction_summary,p_capture_client,p_coverage,event_list);
  -- Concurrent legacy requests retain the old unique batch/hash semantics.
  if coalesce((result->>'idempotentReplay')::boolean,false) then return result; end if;
 else
  insert into public.ingestion_batches(workspace_id,batch_id,requested_by,provider,reason,status,raw_object_key,payload_sha256,payload_bytes,redaction_summary,schema_version,provider_family,product,surface,capture_session_id)
   values(p_workspace_id,p_batch_id,p_user_id,p_provider,p_reason,'processing',p_raw_object_key,p_payload_sha256,p_payload_bytes,p_redaction_summary,2,p_provider_family,p_product,p_surface,p_capture_client->>'captureSessionId');
  result:=jsonb_build_object('idempotentReplay',false,'status','committed','received',0,'inserted',0,'updated',0,'duplicates',0);
 end if;
 for item in select value from jsonb_array_elements(event_list) loop
  m:=item->'sourceMetadata';
  if m is null and item->'captureEvidence' is null then continue; end if;
  select * into stored_event from public.conversation_events where workspace_id=p_workspace_id and provider=p_product
   and provider_conversation_id=item->>'conversationId' and (event_key=item->>'eventId'
    or (m->>'messageIdentity'='provider' and source_metadata->>'messageIdentity'='provider'
      and nullif(item->>'providerMessageId','') is not null and provider_message_id=item->>'providerMessageId'))
   order by case when event_key=item->>'eventId' then 0 else 1 end limit 1 for update;
  update public.conversation_events set source_metadata=coalesce(m,source_metadata),
   message_timestamp=coalesce((item->>'messageTimestamp')::timestamptz,message_timestamp),
   provider_message_id=coalesce(nullif(item->>'providerMessageId',''),provider_message_id),
   capture_evidence=coalesce(nullif(item->'captureEvidence','null'::jsonb),capture_evidence) where id=stored_event.id;
  if not found then raise exception 'source_metadata_event_not_found'; end if;
  if m is null then continue; end if;
  update public.conversations set title=btrim(item->>'chatTitle'),source_metadata=m,source_metadata_observed_at=(item->>'capturedAt')::timestamptz,
   source_metadata_device_key=p_capture_client->>'deviceId'
   where workspace_id=p_workspace_id and provider=p_product and provider_conversation_id=item->>'conversationId'
    and (source_metadata_observed_at is null or source_metadata_observed_at<=(item->>'capturedAt')::timestamptz);
 end loop;
 for item in select value from jsonb_array_elements(p_conversation_updates) loop
  m:=item->'sourceMetadata';identity_basis:=m->>'conversationIdentity';
  if not public.valid_source_metadata_v1(m) or identity_basis not in ('provider','local')
   or m->>'messageIdentity'<>'unknown' or m->>'timestampBasis'<>'unknown' or m->>'linksStatus'<>'unknown' or m->>'attachmentsStatus'<>'unknown'
   or coalesce(char_length(btrim(item->>'chatTitle')),0) not between 1 and 1000 or item->>'capturedAt' is null then raise exception 'invalid_source_metadata_update'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||':'||p_product||':'||(item->>'conversationId'),0));
  if item ? '_sherryDeletionOperation' and item->>'_sherryDeletionOperation' is distinct from coalesce((select d.operation_id::text from public.deleted_conversations d where d.workspace_id=p_workspace_id and d.provider=p_product and d.provider_conversation_id=item->>'conversationId'),'initial') then raise exception 'capture_deletion_boundary_changed'; end if;
  if exists(select 1 from public.deleted_conversations d where d.workspace_id=p_workspace_id and d.provider=p_product and d.provider_conversation_id=item->>'conversationId' and d.archive_reconciled_at is null) then raise exception 'conversation_deletion_cleanup_pending'; end if;
  select * into existing from public.conversations where workspace_id=p_workspace_id and provider=p_product and provider_conversation_id=item->>'conversationId' for update;
  if not found or existing.source_metadata->>'conversationIdentity' is distinct from identity_basis
   or (identity_basis='local' and existing.source_metadata_device_key is distinct from p_capture_client->>'deviceId') then raise exception 'source_metadata_identity_unproven'; end if;
  -- The original event source evidence is not overwritten by title-only evidence.
  update public.conversations set title=btrim(item->>'chatTitle'),
   source_metadata=jsonb_set(source_metadata,'{titleBasis}',m->'titleBasis'),source_metadata_observed_at=(item->>'capturedAt')::timestamptz
   where id=existing.id and (source_metadata_observed_at is null or source_metadata_observed_at<(item->>'capturedAt')::timestamptz)
    ;
  get diagnostics affected=row_count;
  if existing.title is distinct from btrim(item->>'chatTitle') or existing.source_metadata->>'titleBasis' is distinct from m->>'titleBasis' then changed:=changed+affected; end if;
 end loop;
 update public.ingestion_batches set status='committed',committed_at=coalesce(committed_at,now()),metadata_updated_count=changed,metadata_received_count=jsonb_array_length(p_conversation_updates),
  provider_conversation_ids=array(select distinct value->>'conversationId' from jsonb_array_elements(p_events||p_conversation_updates))
 where workspace_id=p_workspace_id and batch_id=p_batch_id;
 return result||jsonb_build_object('metadataUpdated',changed,'metadataReceived',jsonb_array_length(p_conversation_updates));
end $$;
revoke all on function public.ingest_capture_batch_v2_source_metadata(uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,jsonb,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_capture_batch_v2_source_metadata(uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;

-- New classifications distinguish source times from session fallbacks. Preserve
-- legacy behavior for unclassified rows; new local identities use event identity,
-- never equal text, to identify genuinely distinct observed messages.
create or replace function public.conversation_activity_rollup(p_workspace_id uuid)
returns table(conversation_id uuid,source_message_at timestamptz,first_new_content_at timestamptz)
language sql stable security invoker set search_path='' as $$
 with source_times as (
  select e.conversation_id,max(e.message_timestamp) as source_message_at from public.conversation_events e
  where e.workspace_id=p_workspace_id and (e.source_metadata is null or e.source_metadata->>'timestampBasis'='source') group by e.conversation_id
 ), distinct_capture as (
  select e.conversation_id,case
   when e.source_metadata is not null and e.source_metadata->>'messageIdentity'<>'provider' then 'event:'||e.event_key
   when e.provider_message_id is not null then 'id:'||e.provider_message_id
   when char_length(e.text_content)>=60 then 'text:'||md5(e.role||':'||e.text_content)
   else 'event:'||e.event_key end as identity_key,min(e.first_captured_at) as first_seen_at
  from public.conversation_events e where e.workspace_id=p_workspace_id
   and (e.message_timestamp is null or (e.source_metadata is not null and e.source_metadata->>'timestampBasis'<>'source'))
   and coalesce(e.source_locator,'') not like 'historical-import:%'
  group by e.conversation_id,identity_key
 ), capture_times as (select dc.conversation_id,max(dc.first_seen_at) as first_new_content_at from distinct_capture dc group by dc.conversation_id)
 select c.id,s.source_message_at,ct.first_new_content_at from public.conversations c
 left join source_times s on s.conversation_id=c.id left join capture_times ct on ct.conversation_id=c.id where c.workspace_id=p_workspace_id
$$;
