-- Additive: existing clients and ingestion RPCs keep their current behavior.
alter table public.conversation_events add column capture_evidence jsonb;
alter table public.conversation_events add constraint conversation_events_capture_evidence_valid check (
  capture_evidence is null or coalesce((
    jsonb_typeof(capture_evidence) = 'object'
    and capture_evidence->'version' = '1'::jsonb
    and capture_evidence->>'conversationIdentity' = 'local_session'
    and capture_evidence->>'messageIdentity' = 'local_sequence'
    and capture_evidence->>'timestampBasis' = 'observed'
    and capture_evidence->>'orderBasis' = 'session_sequence'
    and capture_evidence->>'completeness' in ('unknown', 'possibly_clipped')
    and capture_evidence->>'titleBasis' = 'placeholder'
    and octet_length(capture_evidence::text) <= 1024
    and source_locator like 'android-session:%'
    and provider_conversation_id = source_locator
    and surface = 'android' and message_timestamp is null and provider_message_id is null
  ), false)
);
comment on column public.conversation_events.capture_evidence is
  'Versioned evidence for local Android sessions. Null means legacy/unspecified, never full completeness. captured_at is an observation time.';

create function public.ingest_capture_batch_v2_evidence(
  p_user_id uuid, p_workspace_id uuid, p_batch_id uuid, p_provider text,
  p_provider_family text, p_product text, p_surface text, p_reason text,
  p_raw_object_key text, p_payload_sha256 text, p_payload_bytes bigint,
  p_redaction_summary jsonb, p_capture_client jsonb, p_coverage jsonb, p_events jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_result jsonb;
  v_event jsonb;
begin
  -- The existing RPC checks ownership, revocation, tombstones, batch conflicts,
  -- source/event identity, RLS boundaries and provenance before any new write.
  v_result := public.ingest_capture_batch_v2(
    p_user_id, p_workspace_id, p_batch_id, p_provider, p_provider_family,
    p_product, p_surface, p_reason, p_raw_object_key, p_payload_sha256,
    p_payload_bytes, p_redaction_summary, p_capture_client, p_coverage, p_events
  );
  if coalesce((v_result->>'idempotentReplay')::boolean, false) then return v_result; end if;
  for v_event in select value from jsonb_array_elements(p_events) loop
    if v_event->'captureEvidence' is not null and v_event->'captureEvidence' <> 'null'::jsonb then
      update public.conversation_events set capture_evidence = v_event->'captureEvidence'
      where workspace_id = p_workspace_id and provider = p_product
        and provider_conversation_id = v_event->>'conversationId'
        and event_key = v_event->>'eventId';
      if not found then raise exception 'capture_evidence_event_not_found'; end if;
    end if;
  end loop;
  return v_result;
end;
$$;
revoke all on function public.ingest_capture_batch_v2_evidence(uuid, uuid, uuid, text, text, text, text, text, text, text, bigint, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_capture_batch_v2_evidence(uuid, uuid, uuid, text, text, text, text, text, text, text, bigint, jsonb, jsonb, jsonb, jsonb) to service_role;

-- Mobile reads of older chats do not establish a new message date.
-- Read-only activity rollup. Browser scans can rediscover an unchanged message
-- under a different on-screen position; an upload is not a new chat message.
create or replace function public.conversation_activity_rollup(p_workspace_id uuid)
returns table (conversation_id uuid, source_message_at timestamptz, first_new_content_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  with source_times as (
    select e.conversation_id, max(e.message_timestamp) as source_message_at
    from public.conversation_events e
    where e.workspace_id = p_workspace_id
    group by e.conversation_id
  ), distinct_capture as (
    select e.conversation_id,
      case
        when e.provider_message_id is not null then 'id:' || e.provider_message_id
        when char_length(e.text_content) >= 60 then 'text:' || md5(e.role || ':' || e.text_content)
        else 'event:' || e.event_key
      end as identity_key,
      min(e.first_captured_at) as first_seen_at
    from public.conversation_events e
    where e.workspace_id = p_workspace_id
      and e.message_timestamp is null
      and coalesce(e.source_locator, '') not like 'android-session:%'
      and coalesce(e.source_locator, '') not like 'android-chatgpt:%'
      and coalesce(e.source_locator, '') not like 'historical-import:%'
    group by e.conversation_id, identity_key
  ), capture_times as (
    select dc.conversation_id, max(dc.first_seen_at) as first_new_content_at
    from distinct_capture dc
    group by dc.conversation_id
  )
  select c.id, s.source_message_at, ct.first_new_content_at
  from public.conversations c
  left join source_times s on s.conversation_id = c.id
  left join capture_times ct on ct.conversation_id = c.id
  where c.workspace_id = p_workspace_id;
$$;

revoke all on function public.conversation_activity_rollup(uuid) from public, anon, authenticated;
grant execute on function public.conversation_activity_rollup(uuid) to service_role;
