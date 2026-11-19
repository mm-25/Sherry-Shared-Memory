-- Add mobile observation metadata to the current deployment without replacing
-- message identity, deletion-generation or conversation activity behavior.
alter table public.conversation_events add column if not exists capture_evidence jsonb;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.conversation_events'::regclass
      and conname = 'conversation_events_mobile_observation_valid') then
    alter table public.conversation_events add constraint conversation_events_mobile_observation_valid check (
      capture_evidence is null or coalesce((
        jsonb_typeof(capture_evidence) = 'object'
        and capture_evidence - array['version','conversationIdentity','messageIdentity','timestampBasis','orderBasis','completeness','titleBasis']::text[] = '{}'::jsonb
        and capture_evidence->'version' = '1'::jsonb
        and capture_evidence->>'conversationIdentity' = 'local_session'
        and capture_evidence->>'messageIdentity' = 'local_sequence'
        and capture_evidence->>'timestampBasis' = 'observed'
        and capture_evidence->>'orderBasis' = 'session_sequence'
        and capture_evidence->>'completeness' in ('unknown','possibly_clipped')
        and capture_evidence->>'titleBasis' = 'placeholder'
        and octet_length(capture_evidence::text) <= 1024
        and source_locator like 'android-session:%'
        and provider_conversation_id = source_locator
        and surface = 'android' and message_timestamp is null and provider_message_id is null
      ),false)
    );
  end if;
end;
$$;
comment on column public.conversation_events.capture_evidence is
  'Versioned local Android observation evidence; source message identity/date and full completeness remain unknown.';

create or replace function public.ingest_capture_batch_v2_evidence(
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
  -- Delegate ownership, revocation, safe message identity, immutable replay and
  -- current recapture-generation checks to the existing ingestion transaction.
  v_result := public.ingest_capture_batch_v2(
    p_user_id,p_workspace_id,p_batch_id,p_provider,p_provider_family,
    p_product,p_surface,p_reason,p_raw_object_key,p_payload_sha256,
    p_payload_bytes,p_redaction_summary,p_capture_client,p_coverage,p_events
  );
  if coalesce((v_result->>'idempotentReplay')::boolean,false) then return v_result; end if;
  for v_event in select value from jsonb_array_elements(p_events) loop
    if v_event->'captureEvidence' is not null and v_event->'captureEvidence' <> 'null'::jsonb then
      update public.conversation_events set capture_evidence=v_event->'captureEvidence'
      where workspace_id=p_workspace_id and provider=p_product
        and provider_conversation_id=v_event->>'conversationId'
        and event_key=v_event->>'eventId';
      if not found then raise exception 'capture_evidence_event_not_found'; end if;
    end if;
  end loop;
  return v_result;
end;
$$;
revoke all on function public.ingest_capture_batch_v2_evidence(uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_capture_batch_v2_evidence(uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,jsonb,jsonb,jsonb,jsonb) to service_role;
