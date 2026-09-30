create extension if not exists pgcrypto with schema extensions;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'My Memory',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_one_personal_workspace unique (owner_user_id),
  constraint workspaces_name_not_blank check (char_length(btrim(name)) between 1 and 120)
);

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  source_type text not null default 'conversation_provider',
  title text not null,
  canonical_url text,
  capture_status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sources_provider_allowed check (provider in ('chatgpt', 'claude', 'gemini')),
  constraint sources_type_allowed check (source_type in ('conversation_provider', 'conversation', 'document', 'note')),
  constraint sources_capture_status_allowed check (capture_status in ('active', 'paused', 'disconnected', 'error')),
  constraint sources_workspace_provider_type_unique unique (workspace_id, provider, source_type)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete cascade,
  provider text not null,
  provider_conversation_id text not null,
  title text not null,
  canonical_chat_url text not null,
  url_observed_at timestamptz not null,
  first_captured_at timestamptz not null,
  last_captured_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_provider_allowed check (provider in ('chatgpt', 'claude', 'gemini')),
  constraint conversations_provider_id_not_blank check (char_length(btrim(provider_conversation_id)) between 1 and 512),
  constraint conversations_workspace_provider_id_unique unique (workspace_id, provider, provider_conversation_id)
);

create table public.ingestion_batches (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  batch_id uuid not null,
  requested_by uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  reason text not null,
  status text not null default 'processing',
  raw_object_key text not null,
  payload_sha256 text not null,
  payload_bytes bigint not null,
  redaction_summary jsonb not null default '{}'::jsonb,
  received_count integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  duplicate_count integer not null default 0,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  constraint ingestion_batches_provider_allowed check (provider in ('chatgpt', 'claude', 'gemini')),
  constraint ingestion_batches_status_allowed check (status in ('processing', 'committed', 'failed')),
  constraint ingestion_batches_payload_bytes_nonnegative check (payload_bytes >= 0),
  constraint ingestion_batches_workspace_batch_unique unique (workspace_id, batch_id)
);

create table public.conversation_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  ingestion_batch_id bigint not null references public.ingestion_batches(id) on delete restrict,
  provider text not null,
  provider_conversation_id text not null,
  event_key text not null,
  provider_message_id text,
  sequence integer not null,
  role text not null,
  text_content text not null,
  content_hash text not null,
  source_url text not null,
  message_timestamp timestamptz,
  captured_at timestamptz not null,
  first_captured_at timestamptz not null,
  last_captured_at timestamptz not null,
  raw_object_key text not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversation_events_provider_allowed check (provider in ('chatgpt', 'claude', 'gemini')),
  constraint conversation_events_role_allowed check (role in ('user', 'assistant', 'system', 'tool', 'unknown')),
  constraint conversation_events_sequence_nonnegative check (sequence >= 0),
  constraint conversation_events_revision_positive check (revision > 0),
  constraint conversation_events_text_not_blank check (char_length(btrim(text_content)) > 0),
  constraint conversation_events_workspace_conversation_event_unique unique (workspace_id, conversation_id, event_key)
);

create unique index conversation_events_provider_message_unique_idx
  on public.conversation_events (workspace_id, provider, provider_conversation_id, provider_message_id)
  where provider_message_id is not null;

create table public.conversation_links (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_event_id bigint not null references public.conversation_events(id) on delete cascade,
  url text not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint conversation_links_event_url_unique unique (conversation_event_id, url)
);

create table public.text_chunks (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  source_event_id bigint not null references public.conversation_events(id) on delete cascade,
  chunk_index integer not null default 0,
  content text not null,
  token_count integer,
  search_vector tsvector generated always as (to_tsvector('simple'::regconfig, coalesce(content, ''))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint text_chunks_chunk_index_nonnegative check (chunk_index >= 0),
  constraint text_chunks_token_count_nonnegative check (token_count is null or token_count >= 0),
  constraint text_chunks_event_chunk_unique unique (source_event_id, chunk_index)
);

create table public.sync_cursors (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  provider text not null,
  provider_conversation_id text not null,
  last_sequence integer not null,
  last_event_key text not null,
  last_content_hash text not null,
  last_captured_at timestamptz not null,
  gap_detected boolean not null default false,
  backfill_required boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint sync_cursors_provider_allowed check (provider in ('chatgpt', 'claude', 'gemini')),
  constraint sync_cursors_last_sequence_nonnegative check (last_sequence >= 0),
  constraint sync_cursors_conversation_unique unique (workspace_id, conversation_id)
);

create table public.diagnostic_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text,
  stage text not null,
  status text not null,
  request_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint diagnostic_events_provider_allowed check (provider is null or provider in ('chatgpt', 'claude', 'gemini')),
  constraint diagnostic_events_status_allowed check (status in ('ok', 'warning', 'error'))
);

create index workspaces_owner_user_id_idx on public.workspaces (owner_user_id);
create index sources_workspace_id_idx on public.sources (workspace_id);
create index conversations_workspace_last_captured_idx on public.conversations (workspace_id, last_captured_at desc);
create index conversations_source_id_idx on public.conversations (source_id);
create index ingestion_batches_workspace_created_idx on public.ingestion_batches (workspace_id, created_at desc);
create index ingestion_batches_requested_by_idx on public.ingestion_batches (requested_by);
create index conversation_events_workspace_captured_idx on public.conversation_events (workspace_id, captured_at desc);
create index conversation_events_conversation_sequence_idx on public.conversation_events (conversation_id, sequence);
create index conversation_events_ingestion_batch_id_idx on public.conversation_events (ingestion_batch_id);
create index conversation_links_workspace_id_idx on public.conversation_links (workspace_id);
create index conversation_links_event_id_idx on public.conversation_links (conversation_event_id);
create index text_chunks_workspace_id_idx on public.text_chunks (workspace_id);
create index text_chunks_conversation_id_idx on public.text_chunks (conversation_id);
create index text_chunks_search_vector_idx on public.text_chunks using gin (search_vector);
create index sync_cursors_workspace_id_idx on public.sync_cursors (workspace_id);
create index sync_cursors_conversation_id_idx on public.sync_cursors (conversation_id);
create index diagnostic_events_workspace_created_idx on public.diagnostic_events (workspace_id, created_at desc);

alter table public.workspaces enable row level security;
alter table public.workspaces force row level security;
alter table public.sources enable row level security;
alter table public.sources force row level security;
alter table public.conversations enable row level security;
alter table public.conversations force row level security;
alter table public.ingestion_batches enable row level security;
alter table public.ingestion_batches force row level security;
alter table public.conversation_events enable row level security;
alter table public.conversation_events force row level security;
alter table public.conversation_links enable row level security;
alter table public.conversation_links force row level security;
alter table public.text_chunks enable row level security;
alter table public.text_chunks force row level security;
alter table public.sync_cursors enable row level security;
alter table public.sync_cursors force row level security;
alter table public.diagnostic_events enable row level security;
alter table public.diagnostic_events force row level security;

create policy workspaces_select_own on public.workspaces
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

create policy workspaces_insert_own on public.workspaces
  for insert to authenticated
  with check (owner_user_id = (select auth.uid()));

create policy workspaces_update_own on public.workspaces
  for update to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));

create policy sources_select_owned_workspace on public.sources
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = sources.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy conversations_select_owned_workspace on public.conversations
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = conversations.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy ingestion_batches_select_owned_workspace on public.ingestion_batches
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = ingestion_batches.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy conversation_events_select_owned_workspace on public.conversation_events
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = conversation_events.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy conversation_links_select_owned_workspace on public.conversation_links
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = conversation_links.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy text_chunks_select_owned_workspace on public.text_chunks
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = text_chunks.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy sync_cursors_select_owned_workspace on public.sync_cursors
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = sync_cursors.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy diagnostic_events_select_owned_workspace on public.diagnostic_events
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = diagnostic_events.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

revoke all on public.workspaces, public.sources, public.conversations, public.ingestion_batches,
  public.conversation_events, public.conversation_links, public.text_chunks, public.sync_cursors,
  public.diagnostic_events from anon, authenticated;

grant select, insert, update on public.workspaces to authenticated;
grant select on public.sources, public.conversations, public.ingestion_batches, public.conversation_events,
  public.conversation_links, public.text_chunks, public.sync_cursors, public.diagnostic_events to authenticated;

create or replace function public.ingest_capture_batch(
  p_user_id uuid,
  p_workspace_id uuid,
  p_batch_id uuid,
  p_provider text,
  p_reason text,
  p_raw_object_key text,
  p_payload_sha256 text,
  p_payload_bytes bigint,
  p_redaction_summary jsonb,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_row public.ingestion_batches%rowtype;
  v_event jsonb;
  v_source_id uuid;
  v_conversation_id uuid;
  v_event_id bigint;
  v_existing_hash text;
  v_event_key text;
  v_provider_conversation_id text;
  v_provider_message_id text;
  v_role text;
  v_text text;
  v_content_hash text;
  v_source_url text;
  v_title text;
  v_sequence integer;
  v_message_timestamp timestamptz;
  v_captured_at timestamptz;
  v_link jsonb;
  v_received integer := 0;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_duplicates integer := 0;
begin
  if p_user_id is null or not exists (
    select 1 from public.workspaces
    where id = p_workspace_id and owner_user_id = p_user_id
  ) then
    raise insufficient_privilege using message = 'workspace_not_owned';
  end if;

  if p_provider not in ('chatgpt', 'claude', 'gemini') then
    raise data_exception using message = 'provider_not_supported';
  end if;

  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) < 1 or jsonb_array_length(p_events) > 100 then
    raise data_exception using message = 'invalid_event_count';
  end if;

  if p_raw_object_key not like concat(
    p_workspace_id::text, '/', p_provider, '/%/', p_batch_id::text, '.json'
  ) then
    raise data_exception using message = 'invalid_raw_object_key';
  end if;

  insert into public.ingestion_batches (
    workspace_id, batch_id, requested_by, provider, reason, status, raw_object_key,
    payload_sha256, payload_bytes, redaction_summary, received_count
  ) values (
    p_workspace_id, p_batch_id, p_user_id, p_provider, p_reason, 'processing', p_raw_object_key,
    p_payload_sha256, p_payload_bytes, coalesce(p_redaction_summary, '{}'::jsonb), jsonb_array_length(p_events)
  )
  on conflict (workspace_id, batch_id) do nothing
  returning * into v_batch_row;

  if v_batch_row.id is null then
    select * into v_batch_row
    from public.ingestion_batches
    where workspace_id = p_workspace_id and batch_id = p_batch_id;

    if v_batch_row.payload_sha256 is distinct from p_payload_sha256 then
      raise data_exception using message = 'idempotency_payload_mismatch';
    end if;

    return jsonb_build_object(
      'idempotentReplay', true,
      'status', v_batch_row.status,
      'received', v_batch_row.received_count,
      'inserted', v_batch_row.inserted_count,
      'updated', v_batch_row.updated_count,
      'duplicates', v_batch_row.duplicate_count
    );
  end if;

  insert into public.sources (workspace_id, provider, source_type, title, capture_status)
  values (p_workspace_id, p_provider, 'conversation_provider', initcap(p_provider), 'active')
  on conflict (workspace_id, provider, source_type)
  do update set updated_at = now()
  returning id into v_source_id;

  for v_event in select value from jsonb_array_elements(p_events)
  loop
    v_received := v_received + 1;
    v_event_key := btrim(v_event->>'eventId');
    v_provider_conversation_id := btrim(v_event->>'conversationId');
    v_provider_message_id := nullif(btrim(v_event->>'providerMessageId'), '');
    v_sequence := (v_event->>'sequence')::integer;
    v_role := v_event->>'role';
    v_text := v_event->>'text';
    v_content_hash := v_event->>'contentHash';
    v_source_url := v_event->>'sourceUrl';
    v_title := v_event->>'chatTitle';
    v_message_timestamp := nullif(v_event->>'messageTimestamp', '')::timestamptz;
    v_captured_at := (v_event->>'capturedAt')::timestamptz;

    insert into public.conversations (
      workspace_id, source_id, provider, provider_conversation_id, title, canonical_chat_url,
      url_observed_at, first_captured_at, last_captured_at
    ) values (
      p_workspace_id, v_source_id, p_provider, v_provider_conversation_id, v_title, v_source_url,
      v_captured_at, v_captured_at, v_captured_at
    )
    on conflict (workspace_id, provider, provider_conversation_id)
    do update set
      title = excluded.title,
      canonical_chat_url = excluded.canonical_chat_url,
      url_observed_at = greatest(public.conversations.url_observed_at, excluded.url_observed_at),
      last_captured_at = greatest(public.conversations.last_captured_at, excluded.last_captured_at),
      updated_at = now()
    returning id into v_conversation_id;

    v_event_id := null;
    v_existing_hash := null;
    select id, content_hash into v_event_id, v_existing_hash
    from public.conversation_events
    where workspace_id = p_workspace_id
      and conversation_id = v_conversation_id
      and (
        event_key = v_event_key
        or (v_provider_message_id is not null and provider_message_id = v_provider_message_id)
      )
    order by
      case when event_key = v_event_key then 0
           else 1 end
    limit 1
    for update;

    if v_event_id is null then
      insert into public.conversation_events (
        workspace_id, conversation_id, ingestion_batch_id, provider, provider_conversation_id,
        event_key, provider_message_id, sequence, role, text_content, content_hash, source_url,
        message_timestamp, captured_at, first_captured_at, last_captured_at, raw_object_key
      ) values (
        p_workspace_id, v_conversation_id, v_batch_row.id, p_provider, v_provider_conversation_id,
        v_event_key, v_provider_message_id, v_sequence, v_role, v_text, v_content_hash, v_source_url,
        v_message_timestamp, v_captured_at, v_captured_at, v_captured_at, p_raw_object_key
      ) returning id into v_event_id;
      v_inserted := v_inserted + 1;
    elsif v_existing_hash is distinct from v_content_hash then
      update public.conversation_events set
        ingestion_batch_id = v_batch_row.id,
        provider_message_id = coalesce(v_provider_message_id, provider_message_id),
        text_content = v_text,
        content_hash = v_content_hash,
        source_url = v_source_url,
        message_timestamp = coalesce(v_message_timestamp, message_timestamp),
        captured_at = greatest(captured_at, v_captured_at),
        last_captured_at = greatest(last_captured_at, v_captured_at),
        raw_object_key = p_raw_object_key,
        revision = revision + 1,
        updated_at = now()
      where id = v_event_id;
      v_updated := v_updated + 1;
    else
      update public.conversation_events set
        last_captured_at = greatest(last_captured_at, v_captured_at),
        updated_at = now()
      where id = v_event_id;
      v_duplicates := v_duplicates + 1;
    end if;

    insert into public.text_chunks (workspace_id, conversation_id, source_event_id, chunk_index, content)
    values (p_workspace_id, v_conversation_id, v_event_id, 0, v_text)
    on conflict (source_event_id, chunk_index)
    do update set content = excluded.content, updated_at = now();

    for v_link in select value from jsonb_array_elements(coalesce(v_event->'links', '[]'::jsonb))
    loop
      insert into public.conversation_links (workspace_id, conversation_event_id, url, observed_at)
      values (p_workspace_id, v_event_id, trim(both '"' from v_link::text), v_captured_at)
      on conflict (conversation_event_id, url) do nothing;
    end loop;

    insert into public.sync_cursors (
      workspace_id, conversation_id, provider, provider_conversation_id, last_sequence,
      last_event_key, last_content_hash, last_captured_at
    ) values (
      p_workspace_id, v_conversation_id, p_provider, v_provider_conversation_id, v_sequence,
      v_event_key, v_content_hash, v_captured_at
    )
    on conflict (workspace_id, conversation_id)
    do update set
      last_sequence = greatest(public.sync_cursors.last_sequence, excluded.last_sequence),
      last_event_key = case when excluded.last_sequence >= public.sync_cursors.last_sequence
        then excluded.last_event_key else public.sync_cursors.last_event_key end,
      last_content_hash = case when excluded.last_sequence >= public.sync_cursors.last_sequence
        then excluded.last_content_hash else public.sync_cursors.last_content_hash end,
      last_captured_at = greatest(public.sync_cursors.last_captured_at, excluded.last_captured_at),
      updated_at = now();
  end loop;

  update public.ingestion_batches set
    status = 'committed',
    received_count = v_received,
    inserted_count = v_inserted,
    updated_count = v_updated,
    duplicate_count = v_duplicates,
    committed_at = now()
  where id = v_batch_row.id;

  insert into public.diagnostic_events (workspace_id, provider, stage, status, request_id, detail)
  values (
    p_workspace_id,
    p_provider,
    'ingestion_commit',
    'ok',
    p_batch_id::text,
    jsonb_build_object(
      'received', v_received,
      'inserted', v_inserted,
      'updated', v_updated,
      'duplicates', v_duplicates,
      'rawObjectKey', p_raw_object_key,
      'redactions', coalesce(p_redaction_summary, '{}'::jsonb)
    )
  );

  return jsonb_build_object(
    'idempotentReplay', false,
    'status', 'committed',
    'received', v_received,
    'inserted', v_inserted,
    'updated', v_updated,
    'duplicates', v_duplicates
  );
end;
$$;

revoke all on function public.ingest_capture_batch(uuid, uuid, uuid, text, text, text, text, bigint, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_capture_batch(uuid, uuid, uuid, text, text, text, text, bigint, jsonb, jsonb)
  to service_role;
