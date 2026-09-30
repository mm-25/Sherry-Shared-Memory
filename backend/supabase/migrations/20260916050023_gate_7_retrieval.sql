create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_name_not_blank check (char_length(btrim(name)) between 1 and 120)
);
create unique index projects_one_default_idx on public.projects(workspace_id) where is_default;
create index projects_workspace_idx on public.projects(workspace_id, updated_at desc);

create table public.memory_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  title text not null,
  content text not null,
  tags text[] not null default '{}'::text[],
  authority text not null default 'user_authored',
  search_vector tsvector generated always as (
    to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || coalesce(content, ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memory_notes_title_not_blank check (char_length(btrim(title)) between 1 and 200),
  constraint memory_notes_content_not_blank check (char_length(btrim(content)) between 1 and 30000),
  constraint memory_notes_authority_allowed check (authority in ('user_authored', 'provider_authored'))
);
create index memory_notes_workspace_idx on public.memory_notes(workspace_id, updated_at desc);
create index memory_notes_search_idx on public.memory_notes using gin(search_vector);
create index memory_notes_project_idx on public.memory_notes(project_id);

create table public.retrieval_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  client_id text,
  client_name text,
  read_enabled boolean not null default true,
  write_notes_enabled boolean not null default false,
  scopes text[] not null default array['memory:read']::text[],
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint retrieval_connections_provider_allowed check (provider in ('chatgpt', 'claude', 'gemini', 'grok', 'generic', 'web_test')),
  constraint retrieval_connections_unique unique (workspace_id, provider)
);
create index retrieval_connections_user_idx on public.retrieval_connections(user_id, updated_at desc);

create table public.retrieval_requests (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  tool_name text not null,
  query_sha256 text,
  result_refs jsonb not null default '[]'::jsonb,
  result_count integer not null default 0,
  latency_ms integer not null default 0,
  outcome text not null,
  created_at timestamptz not null default now(),
  constraint retrieval_requests_provider_allowed check (provider in ('chatgpt', 'claude', 'gemini', 'grok', 'generic', 'web_test')),
  constraint retrieval_requests_outcome_allowed check (outcome in ('success', 'denied', 'error')),
  constraint retrieval_requests_query_hash_format check (query_sha256 is null or query_sha256 ~ '^[0-9a-f]{64}$'),
  constraint retrieval_requests_metrics_nonnegative check (result_count >= 0 and latency_ms >= 0)
);
create index retrieval_requests_workspace_created_idx on public.retrieval_requests(workspace_id, created_at desc);
create index retrieval_requests_user_idx on public.retrieval_requests(user_id, created_at desc);

alter table public.projects enable row level security;
alter table public.projects force row level security;
alter table public.memory_notes enable row level security;
alter table public.memory_notes force row level security;
alter table public.retrieval_connections enable row level security;
alter table public.retrieval_connections force row level security;
alter table public.retrieval_requests enable row level security;
alter table public.retrieval_requests force row level security;

create policy projects_owned on public.projects for select to authenticated using (
  exists (select 1 from public.workspaces w where w.id = projects.workspace_id and w.owner_user_id = (select auth.uid()))
);
create policy notes_owned on public.memory_notes for select to authenticated using (
  exists (select 1 from public.workspaces w where w.id = memory_notes.workspace_id and w.owner_user_id = (select auth.uid()))
);
create policy retrieval_connections_owned on public.retrieval_connections for select to authenticated using (user_id = (select auth.uid()));
create policy retrieval_requests_owned on public.retrieval_requests for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.projects, public.memory_notes, public.retrieval_connections, public.retrieval_requests from anon, authenticated;
grant select on public.projects, public.memory_notes, public.retrieval_connections, public.retrieval_requests to authenticated;
grant select, insert, update, delete on public.projects, public.memory_notes, public.retrieval_connections, public.retrieval_requests to service_role;
grant usage, select on sequence public.retrieval_requests_id_seq to service_role;

insert into public.projects(workspace_id, name, description, is_default)
select id, 'Personal memory', 'The default scope for memories that are not assigned to a project.', true
from public.workspaces
on conflict do nothing;

create or replace function public.create_default_memory_project()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.projects(workspace_id, name, description, is_default)
  values (new.id, 'Personal memory', 'The default scope for memories that are not assigned to a project.', true);
  return new;
end;
$$;
create trigger workspaces_create_default_memory_project
after insert on public.workspaces for each row execute function public.create_default_memory_project();
revoke all on function public.create_default_memory_project() from public, anon, authenticated;

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
    select 'claim'::text result_type, mc.id::text result_id, mc.display_text content,
      (case when mc.status = 'confirmed' then 8 else 5 end
        + ts_rank_cd(to_tsvector('simple', mc.display_text), coalesce(q.broad_query, q.strict_query))
        + case when to_tsvector('simple', mc.display_text) @@ q.strict_query then 0.5 else 0 end)::real rank,
      mc.authority, mc.status, c.canonical_chat_url source_url, mc.conversation_id,
      ev.id event_id, mc.observed_at,
      jsonb_build_object('predicate', mc.predicate, 'confidence', mc.confidence, 'scope', mc.scope_type) metadata
    from public.memory_claims mc cross join q cross join allowed
    left join public.conversations c on c.id = mc.conversation_id
    left join lateral (
      select ce.id from public.memory_evidence me join public.conversation_events ce on ce.id = me.conversation_event_id
      where me.memory_claim_id = mc.id order by ce.sequence limit 1
    ) ev on true
    where mc.workspace_id = p_workspace_id and mc.status in ('confirmed', 'provisional')
      and (to_tsvector('simple', mc.display_text) @@ q.strict_query
        or (q.broad_query is not null and to_tsvector('simple', mc.display_text) @@ q.broad_query))
    union all
    select 'excerpt', tc.id::text, tc.content,
      (10 + ts_rank_cd(tc.search_vector, coalesce(q.broad_query, q.strict_query))
        + case when tc.search_vector @@ q.strict_query then 0.5 else 0 end)::real, 'captured', 'active',
      c.canonical_chat_url, tc.conversation_id, tc.source_event_id, coalesce(ce.message_timestamp, ce.captured_at),
      jsonb_build_object('role', ce.role, 'sequence', ce.sequence, 'conversationTitle', c.title, 'provider', c.provider)
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
        + case when n.search_vector @@ q.strict_query then 0.5 else 0 end)::real, n.authority, 'active', null, null, null, n.updated_at,
      jsonb_build_object('title', n.title, 'tags', n.tags, 'projectId', n.project_id)
    from public.memory_notes n cross join q cross join allowed
    where n.workspace_id = p_workspace_id
      and (n.search_vector @@ q.strict_query or (q.broad_query is not null and n.search_vector @@ q.broad_query))
  )
  select * from candidates order by rank desc, observed_at desc nulls last limit least(greatest(p_limit, 1), 30);
$$;
revoke all on function public.search_memory_context(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.search_memory_context(uuid, uuid, text, integer) to service_role;
