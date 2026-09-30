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
