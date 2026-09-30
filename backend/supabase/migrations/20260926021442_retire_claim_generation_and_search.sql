-- Gate 8 retirement: preserve historical claim/conflict rows but prevent new ones.
drop trigger if exists memory_claims_create_conflicts_after_insert on public.memory_claims;

create or replace function public.reject_retired_memory_claim_insert()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'memory claim extraction is retired';
end;
$$;
revoke all on function public.reject_retired_memory_claim_insert() from public, anon, authenticated;
drop trigger if exists memory_claims_reject_insert on public.memory_claims;
create trigger memory_claims_reject_insert
before insert on public.memory_claims for each row
execute function public.reject_retired_memory_claim_insert();

-- Keep the same RPC contract, ownership check, and ranking for source excerpts,
-- user notes, and current summaries. Historical claims never enter retrieval.
create or replace function public.search_memory_context(
  p_user_id uuid,
  p_workspace_id uuid,
  p_query text,
  p_limit integer default 12
) returns table (
  result_type text, result_id text, content text, rank real, authority text, status text,
  source_url text, conversation_id uuid, event_id bigint, observed_at timestamptz, metadata jsonb
) language sql stable security definer set search_path = '' as $$
  with allowed as (
    select 1 from public.workspaces where id = p_workspace_id and owner_user_id = p_user_id
  ), terms as (
    select distinct term
    from regexp_split_to_table(
      regexp_replace(lower(left(btrim(p_query), 500)), '[^a-z0-9]+', ' ', 'g'),
      '\s+'
    ) term
    where char_length(term) >= 3
      and term not in (
        'the', 'and', 'for', 'that', 'this', 'with', 'from', 'what', 'which', 'who', 'whom',
        'whose', 'when', 'where', 'why', 'how', 'kind', 'does', 'did', 'has', 'have', 'had',
        'user', 'about', 'into', 'their', 'there', 'would', 'could', 'should', 'please', 'tell'
      )
  ), q as (
    select
      websearch_to_tsquery('simple'::regconfig, left(btrim(p_query), 500)) strict_query,
      case when count(*) > 0
        then to_tsquery('simple'::regconfig, string_agg(term, ' | ' order by term))
        else null::tsquery
      end broad_query
    from terms
  ), candidates as (
    select 'excerpt'::text result_type, tc.id::text result_id, tc.content,
      (10 + ts_rank_cd(tc.search_vector, coalesce(q.broad_query, q.strict_query))
        + case when tc.search_vector @@ q.strict_query then 0.5 else 0 end)::real rank,
      'captured'::text authority, 'active'::text status,
      c.canonical_chat_url source_url, tc.conversation_id, tc.source_event_id event_id,
      coalesce(ce.message_timestamp, ce.captured_at) observed_at,
      jsonb_build_object('role', ce.role, 'sequence', ce.sequence, 'conversationTitle', c.title, 'provider', c.provider) metadata
    from public.text_chunks tc cross join q cross join allowed
    join public.conversation_events ce on ce.id = tc.source_event_id
    join public.conversations c on c.id = tc.conversation_id
    where tc.workspace_id = p_workspace_id
      and (tc.search_vector @@ q.strict_query or (q.broad_query is not null and tc.search_vector @@ q.broad_query))
    union all
    select 'summary', cp.id::text, cp.summary_text,
      (3 + ts_rank_cd(to_tsvector('simple', cp.summary_text), coalesce(q.broad_query, q.strict_query))
        + case when to_tsvector('simple', cp.summary_text) @@ q.strict_query then 0.5 else 0 end)::real,
      case when cp.status = 'user_edited' then 'user_authored' else 'derived' end,
      cp.status, c.canonical_chat_url, cp.conversation_id, cp.last_event_id, cp.created_at,
      jsonb_build_object('version', cp.version, 'topics', cp.topics, 'conversationTitle', c.title, 'provider', c.provider, 'firstEventId', cp.first_event_id, 'lastEventId', cp.last_event_id)
    from public.checkpoints cp cross join q cross join allowed
    join public.conversations c on c.id = cp.conversation_id
    where cp.workspace_id = p_workspace_id and cp.status in ('active', 'user_edited')
      and (to_tsvector('simple', cp.summary_text) @@ q.strict_query
        or (q.broad_query is not null and to_tsvector('simple', cp.summary_text) @@ q.broad_query))
    union all
    select 'note', n.id::text, n.content,
      (9 + ts_rank_cd(n.search_vector, coalesce(q.broad_query, q.strict_query))
        + case when n.search_vector @@ q.strict_query then 0.5 else 0 end)::real,
      n.authority, 'active', null, null, null, n.updated_at,
      jsonb_build_object('title', n.title, 'tags', n.tags, 'projectId', n.project_id)
    from public.memory_notes n cross join q cross join allowed
    where n.workspace_id = p_workspace_id
      and (n.search_vector @@ q.strict_query or (q.broad_query is not null and n.search_vector @@ q.broad_query))
  )
  select * from candidates order by rank desc, observed_at desc nulls last limit least(greatest(p_limit, 1), 30);
$$;
revoke all on function public.search_memory_context(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.search_memory_context(uuid, uuid, text, integer) to service_role;
