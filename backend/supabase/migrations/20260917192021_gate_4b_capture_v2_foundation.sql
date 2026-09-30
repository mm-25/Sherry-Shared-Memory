-- Capture API v2 provenance foundation. Capture API v1 remains callable during rollout.

alter table public.sources drop constraint sources_provider_allowed;
alter table public.sources add constraint sources_provider_allowed
  check (provider in ('chatgpt', 'codex', 'claude', 'claude_code', 'gemini', 'antigravity'));
alter table public.conversations drop constraint conversations_provider_allowed;
alter table public.conversations add constraint conversations_provider_allowed
  check (provider in ('chatgpt', 'codex', 'claude', 'claude_code', 'gemini', 'antigravity'));
alter table public.ingestion_batches drop constraint ingestion_batches_provider_allowed;
alter table public.ingestion_batches add constraint ingestion_batches_provider_allowed
  check (provider in ('chatgpt', 'codex', 'claude', 'claude_code', 'gemini', 'antigravity'));
alter table public.conversation_events drop constraint conversation_events_provider_allowed;
alter table public.conversation_events add constraint conversation_events_provider_allowed
  check (provider in ('chatgpt', 'codex', 'claude', 'claude_code', 'gemini', 'antigravity'));
alter table public.sync_cursors drop constraint sync_cursors_provider_allowed;
alter table public.sync_cursors add constraint sync_cursors_provider_allowed
  check (provider in ('chatgpt', 'codex', 'claude', 'claude_code', 'gemini', 'antigravity'));
alter table public.diagnostic_events drop constraint diagnostic_events_provider_allowed;
alter table public.diagnostic_events add constraint diagnostic_events_provider_allowed
  check (provider is null or provider in ('chatgpt', 'codex', 'claude', 'claude_code', 'gemini', 'antigravity'));

alter table public.conversations alter column canonical_chat_url drop not null;
alter table public.conversations alter column url_observed_at drop not null;
alter table public.conversation_events alter column source_url drop not null;

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  device_key text not null,
  operating_system text not null,
  client_type text not null,
  client_version text not null,
  status text not null default 'active',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint devices_key_not_blank check (char_length(btrim(device_key)) between 8 and 200),
  constraint devices_os_allowed check (operating_system in ('macos', 'windows', 'linux', 'android', 'chromeos', 'ios', 'unknown')),
  constraint devices_client_type_not_blank check (char_length(btrim(client_type)) between 1 and 100),
  constraint devices_client_version_not_blank check (char_length(btrim(client_version)) between 1 and 100),
  constraint devices_status_allowed check (status in ('active', 'revoked')),
  constraint devices_workspace_key_unique unique (workspace_id, device_key)
);

create table public.capture_adapters (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  provider_family text not null,
  product text not null,
  surface text not null,
  adapter_type text not null,
  adapter_version text not null,
  host_app_version text,
  health_status text not null default 'healthy',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capture_adapters_family_allowed check (provider_family in ('openai', 'anthropic', 'google')),
  constraint capture_adapters_product_allowed check (product in ('chatgpt', 'codex', 'claude', 'claude_code', 'gemini', 'antigravity')),
  constraint capture_adapters_surface_allowed check (surface in ('web', 'desktop', 'cli', 'ide', 'android')),
  constraint capture_adapters_type_allowed check (adapter_type in ('browser_dom', 'structured_hook', 'accessibility', 'share', 'historical_import')),
  constraint capture_adapters_version_not_blank check (char_length(btrim(adapter_version)) between 1 and 100),
  constraint capture_adapters_health_allowed check (health_status in ('healthy', 'degraded', 'error', 'disconnected')),
  constraint capture_adapters_identity_unique unique (device_id, product, surface, adapter_type)
);

alter table public.ingestion_batches
  add column schema_version integer not null default 1,
  add column provider_family text,
  add column product text,
  add column surface text not null default 'web',
  add column capture_adapter_id uuid references public.capture_adapters(id) on delete set null,
  add column capture_session_id text,
  add column coverage_state text not null default 'complete_observed_range',
  add column gap_before boolean not null default false,
  add column backfill_available boolean not null default true;

update public.ingestion_batches set
  provider_family = case provider when 'chatgpt' then 'openai' when 'claude' then 'anthropic' else 'google' end,
  product = provider;
alter table public.ingestion_batches alter column provider_family set not null;
alter table public.ingestion_batches alter column product set not null;
alter table public.ingestion_batches add constraint ingestion_batches_schema_version_allowed check (schema_version in (1, 2));
alter table public.ingestion_batches add constraint ingestion_batches_family_allowed check (provider_family in ('openai', 'anthropic', 'google'));
alter table public.ingestion_batches add constraint ingestion_batches_product_allowed check (product in ('chatgpt', 'codex', 'claude', 'claude_code', 'gemini', 'antigravity'));
alter table public.ingestion_batches add constraint ingestion_batches_surface_allowed check (surface in ('web', 'desktop', 'cli', 'ide', 'android'));
alter table public.ingestion_batches add constraint ingestion_batches_coverage_allowed check (coverage_state in ('complete_observed_range', 'partial', 'gap_detected', 'awaiting_backfill'));

alter table public.conversations
  add column provider_family text,
  add column product text,
  add column primary_surface text not null default 'web',
  add column source_locator text,
  add column coverage_state text not null default 'complete_observed_range',
  add column gap_detected boolean not null default false,
  add column backfill_available boolean not null default true;
update public.conversations set
  provider_family = case provider when 'chatgpt' then 'openai' when 'claude' then 'anthropic' else 'google' end,
  product = provider;
alter table public.conversations alter column provider_family set not null;
alter table public.conversations alter column product set not null;
alter table public.conversations add constraint conversations_family_allowed check (provider_family in ('openai', 'anthropic', 'google'));
alter table public.conversations add constraint conversations_product_allowed check (product in ('chatgpt', 'codex', 'claude', 'claude_code', 'gemini', 'antigravity'));
alter table public.conversations add constraint conversations_surface_allowed check (primary_surface in ('web', 'desktop', 'cli', 'ide', 'android'));
alter table public.conversations add constraint conversations_coverage_allowed check (coverage_state in ('complete_observed_range', 'partial', 'gap_detected', 'awaiting_backfill'));

alter table public.conversation_events
  add column provider_family text,
  add column product text,
  add column surface text not null default 'web',
  add column capture_adapter_id uuid references public.capture_adapters(id) on delete set null,
  add column capture_session_id text,
  add column source_locator text,
  add column coverage_state text not null default 'complete_observed_range';
update public.conversation_events set
  provider_family = case provider when 'chatgpt' then 'openai' when 'claude' then 'anthropic' else 'google' end,
  product = provider;
alter table public.conversation_events alter column provider_family set not null;
alter table public.conversation_events alter column product set not null;
alter table public.conversation_events add constraint conversation_events_family_allowed check (provider_family in ('openai', 'anthropic', 'google'));
alter table public.conversation_events add constraint conversation_events_product_allowed check (product in ('chatgpt', 'codex', 'claude', 'claude_code', 'gemini', 'antigravity'));
alter table public.conversation_events add constraint conversation_events_surface_allowed check (surface in ('web', 'desktop', 'cli', 'ide', 'android'));
alter table public.conversation_events add constraint conversation_events_coverage_allowed check (coverage_state in ('complete_observed_range', 'partial', 'gap_detected', 'awaiting_backfill'));

alter table public.sync_cursors
  add column product text,
  add column surface text not null default 'web',
  add column capture_adapter_id uuid references public.capture_adapters(id) on delete set null,
  add column coverage_state text not null default 'complete_observed_range';
update public.sync_cursors set product = provider;
alter table public.sync_cursors alter column product set not null;
alter table public.sync_cursors add constraint sync_cursors_product_allowed check (product in ('chatgpt', 'codex', 'claude', 'claude_code', 'gemini', 'antigravity'));
alter table public.sync_cursors add constraint sync_cursors_surface_allowed check (surface in ('web', 'desktop', 'cli', 'ide', 'android'));
alter table public.sync_cursors add constraint sync_cursors_coverage_allowed check (coverage_state in ('complete_observed_range', 'partial', 'gap_detected', 'awaiting_backfill'));

create or replace function public.set_capture_provenance_defaults()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.product := coalesce(new.product, new.provider);
  new.provider_family := coalesce(
    new.provider_family,
    case new.provider
      when 'chatgpt' then 'openai'
      when 'codex' then 'openai'
      when 'claude' then 'anthropic'
      when 'claude_code' then 'anthropic'
      when 'gemini' then 'google'
      when 'antigravity' then 'google'
    end
  );
  return new;
end;
$$;

create trigger ingestion_batches_capture_provenance_defaults
before insert on public.ingestion_batches
for each row execute function public.set_capture_provenance_defaults();
create trigger conversations_capture_provenance_defaults
before insert on public.conversations
for each row execute function public.set_capture_provenance_defaults();
create trigger conversation_events_capture_provenance_defaults
before insert on public.conversation_events
for each row execute function public.set_capture_provenance_defaults();

create or replace function public.set_capture_product_default()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.product := coalesce(new.product, new.provider);
  return new;
end;
$$;

create trigger sync_cursors_capture_product_default
before insert on public.sync_cursors
for each row execute function public.set_capture_product_default();

revoke all on function public.set_capture_provenance_defaults() from public, anon, authenticated;
revoke all on function public.set_capture_product_default() from public, anon, authenticated;

create index devices_workspace_last_seen_idx on public.devices (workspace_id, last_seen_at desc);
create index capture_adapters_workspace_last_seen_idx on public.capture_adapters (workspace_id, last_seen_at desc);
create index capture_adapters_product_surface_idx on public.capture_adapters (workspace_id, product, surface);
create index ingestion_batches_capture_adapter_idx on public.ingestion_batches (capture_adapter_id, created_at desc);
create index conversation_events_capture_adapter_idx on public.conversation_events (capture_adapter_id, captured_at desc);

alter table public.devices enable row level security;
alter table public.devices force row level security;
alter table public.capture_adapters enable row level security;
alter table public.capture_adapters force row level security;

create policy devices_select_owned_workspace on public.devices
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = devices.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy capture_adapters_select_owned_workspace on public.capture_adapters
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = capture_adapters.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

revoke all on public.devices, public.capture_adapters from anon, authenticated;
grant select on public.devices, public.capture_adapters to authenticated;

do $migration$
declare
  v_definition text;
  v_old_check text := E'if p_provider not in (''chatgpt'', ''claude'', ''gemini'') then';
  v_new_check text := E'if p_provider not in (''chatgpt'', ''codex'', ''claude'', ''claude_code'', ''gemini'', ''antigravity'') then';
begin
  select pg_get_functiondef(
    'public.ingest_capture_batch(uuid,uuid,uuid,text,text,text,text,bigint,jsonb,jsonb)'::regprocedure
  ) into v_definition;
  if strpos(v_definition, v_old_check) > 0 then
    execute replace(v_definition, v_old_check, v_new_check);
  elsif strpos(v_definition, v_new_check) = 0 then
    raise exception 'ingest_capture_batch provider check did not match a supported version';
  end if;
end;
$migration$;

create or replace function public.ingest_capture_batch_v2(
  p_user_id uuid,
  p_workspace_id uuid,
  p_batch_id uuid,
  p_provider text,
  p_provider_family text,
  p_product text,
  p_surface text,
  p_reason text,
  p_raw_object_key text,
  p_payload_sha256 text,
  p_payload_bytes bigint,
  p_redaction_summary jsonb,
  p_capture_client jsonb,
  p_coverage jsonb,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_device_id uuid;
  v_adapter_id uuid;
  v_batch_row_id bigint;
  v_event jsonb;
  v_conversation_id uuid;
  v_coverage_state text := p_coverage->>'state';
  v_gap_before boolean := coalesce((p_coverage->>'gapBefore')::boolean, false);
  v_backfill_available boolean := coalesce((p_coverage->>'backfillAvailable')::boolean, false);
begin
  if p_provider is distinct from p_product then
    raise data_exception using message = 'provider_product_mismatch';
  end if;
  if p_provider_family not in ('openai', 'anthropic', 'google')
    or p_surface not in ('web', 'desktop', 'cli', 'ide', 'android')
    or v_coverage_state not in ('complete_observed_range', 'partial', 'gap_detected', 'awaiting_backfill') then
    raise data_exception using message = 'invalid_capture_provenance';
  end if;
  if nullif(btrim(p_capture_client->>'deviceId'), '') is null
    or nullif(btrim(p_capture_client->>'type'), '') is null
    or nullif(btrim(p_capture_client->>'adapterVersion'), '') is null
    or nullif(btrim(p_capture_client->>'captureSessionId'), '') is null then
    raise data_exception using message = 'invalid_capture_client';
  end if;

  insert into public.devices (
    workspace_id, device_key, operating_system, client_type, client_version, last_seen_at
  ) values (
    p_workspace_id,
    btrim(p_capture_client->>'deviceId'),
    p_capture_client->>'os',
    p_capture_client->>'type',
    p_capture_client->>'adapterVersion',
    now()
  )
  on conflict (workspace_id, device_key) do update set
    operating_system = excluded.operating_system,
    client_type = excluded.client_type,
    client_version = excluded.client_version,
    last_seen_at = excluded.last_seen_at,
    updated_at = now()
  returning id into v_device_id;

  insert into public.capture_adapters (
    workspace_id, device_id, provider_family, product, surface, adapter_type,
    adapter_version, host_app_version, health_status, last_seen_at
  ) values (
    p_workspace_id, v_device_id, p_provider_family, p_product, p_surface,
    p_capture_client->>'type', p_capture_client->>'adapterVersion',
    nullif(btrim(p_capture_client->>'appVersion'), ''), 'healthy', now()
  )
  on conflict (device_id, product, surface, adapter_type) do update set
    provider_family = excluded.provider_family,
    adapter_version = excluded.adapter_version,
    host_app_version = excluded.host_app_version,
    health_status = 'healthy',
    last_seen_at = excluded.last_seen_at,
    updated_at = now()
  returning id into v_adapter_id;

  v_result := public.ingest_capture_batch(
    p_user_id, p_workspace_id, p_batch_id, p_provider, p_reason, p_raw_object_key,
    p_payload_sha256, p_payload_bytes, p_redaction_summary, p_events
  );

  update public.ingestion_batches set
    schema_version = 2,
    provider_family = p_provider_family,
    product = p_product,
    surface = p_surface,
    capture_adapter_id = v_adapter_id,
    capture_session_id = p_capture_client->>'captureSessionId',
    coverage_state = v_coverage_state,
    gap_before = v_gap_before,
    backfill_available = v_backfill_available
  where workspace_id = p_workspace_id and batch_id = p_batch_id
  returning id into v_batch_row_id;

  for v_event in select value from jsonb_array_elements(p_events)
  loop
    v_conversation_id := null;
    update public.conversation_events set
      provider_family = p_provider_family,
      product = p_product,
      surface = p_surface,
      capture_adapter_id = v_adapter_id,
      capture_session_id = p_capture_client->>'captureSessionId',
      source_locator = nullif(btrim(v_event->>'sourceLocator'), ''),
      coverage_state = v_coverage_state,
      updated_at = now()
    where workspace_id = p_workspace_id
      and provider = p_product
      and provider_conversation_id = btrim(v_event->>'conversationId')
      and event_key = btrim(v_event->>'eventId')
    returning conversation_id into v_conversation_id;

    if v_conversation_id is not null then
      update public.conversations set
        provider_family = p_provider_family,
        product = p_product,
        primary_surface = p_surface,
        source_locator = coalesce(nullif(btrim(v_event->>'sourceLocator'), ''), source_locator),
        coverage_state = v_coverage_state,
        gap_detected = gap_detected or v_gap_before or v_coverage_state = 'gap_detected',
        backfill_available = v_backfill_available,
        updated_at = now()
      where id = v_conversation_id;

      update public.sync_cursors set
        product = p_product,
        surface = p_surface,
        capture_adapter_id = v_adapter_id,
        coverage_state = v_coverage_state,
        gap_detected = gap_detected or v_gap_before or v_coverage_state = 'gap_detected',
        backfill_required = backfill_required or v_gap_before or v_coverage_state in ('gap_detected', 'awaiting_backfill'),
        updated_at = now()
      where workspace_id = p_workspace_id and conversation_id = v_conversation_id;
    end if;
  end loop;

  update public.diagnostic_events set detail = detail || jsonb_build_object(
    'schemaVersion', 2,
    'providerFamily', p_provider_family,
    'product', p_product,
    'surface', p_surface,
    'captureAdapterId', v_adapter_id,
    'coverageState', v_coverage_state,
    'gapBefore', v_gap_before
  )
  where id = (
    select id from public.diagnostic_events
    where workspace_id = p_workspace_id
      and stage = 'ingestion_commit'
      and request_id = p_batch_id::text
    order by created_at desc
    limit 1
  );

  return v_result || jsonb_build_object(
    'schemaVersion', 2,
    'captureAdapterId', v_adapter_id,
    'coverageState', v_coverage_state
  );
end;
$$;

revoke all on function public.ingest_capture_batch_v2(
  uuid, uuid, uuid, text, text, text, text, text, text, text, bigint, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_capture_batch_v2(
  uuid, uuid, uuid, text, text, text, text, text, text, text, bigint, jsonb, jsonb, jsonb, jsonb
) to service_role;
