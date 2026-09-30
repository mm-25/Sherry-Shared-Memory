create or replace function public.save_summarizer_configuration(
  p_workspace_id uuid,
  p_user_id uuid,
  p_enabled boolean,
  p_interval_minutes integer,
  p_min_new_events integer,
  p_max_single_event_wait_minutes integer,
  p_continuity_overlap_events integer,
  p_provider text,
  p_model text,
  p_prompt_version text,
  p_secret_action text,
  p_key_ciphertext text default null,
  p_key_iv text default null,
  p_key_version integer default null,
  p_api_key_hint text default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_api_key_configured boolean;
  v_api_key_hint text;
  v_settings public.summarizer_settings;
begin
  if not exists (
    select 1
    from public.workspaces
    where id = p_workspace_id
      and owner_user_id = p_user_id
  ) then
    raise exception 'workspace_not_owned' using errcode = '42501';
  end if;

  if p_secret_action not in ('keep', 'upsert', 'delete') then
    raise exception 'invalid_secret_action' using errcode = '22023';
  end if;

  if p_secret_action = 'upsert' then
    if p_key_ciphertext is null or p_key_iv is null or p_key_version is null or p_api_key_hint is null then
      raise exception 'secret_material_required' using errcode = '22023';
    end if;

    insert into public.summarizer_secrets (
      workspace_id, provider, key_ciphertext, key_iv, key_version, updated_by, updated_at
    ) values (
      p_workspace_id, p_provider, p_key_ciphertext, p_key_iv, p_key_version, p_user_id, p_now
    )
    on conflict (workspace_id) do update set
      provider = excluded.provider,
      key_ciphertext = excluded.key_ciphertext,
      key_iv = excluded.key_iv,
      key_version = excluded.key_version,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;

    v_api_key_configured := true;
    v_api_key_hint := p_api_key_hint;
  elsif p_secret_action = 'delete' then
    delete from public.summarizer_secrets where workspace_id = p_workspace_id;
    v_api_key_configured := false;
    v_api_key_hint := null;
  else
    v_api_key_configured := exists (
      select 1 from public.summarizer_secrets where workspace_id = p_workspace_id
    );
    select api_key_hint
      into v_api_key_hint
      from public.summarizer_settings
      where workspace_id = p_workspace_id;
    if not v_api_key_configured then
      v_api_key_hint := null;
    end if;
  end if;

  insert into public.summarizer_settings (
    workspace_id, enabled, interval_minutes, min_new_events,
    max_single_event_wait_minutes, continuity_overlap_events,
    provider, model, prompt_version, api_key_configured, api_key_hint, updated_at
  ) values (
    p_workspace_id, p_enabled, p_interval_minutes, p_min_new_events,
    p_max_single_event_wait_minutes, p_continuity_overlap_events,
    p_provider, p_model, p_prompt_version, v_api_key_configured, v_api_key_hint, p_now
  )
  on conflict (workspace_id) do update set
    enabled = excluded.enabled,
    interval_minutes = excluded.interval_minutes,
    min_new_events = excluded.min_new_events,
    max_single_event_wait_minutes = excluded.max_single_event_wait_minutes,
    continuity_overlap_events = excluded.continuity_overlap_events,
    provider = excluded.provider,
    model = excluded.model,
    prompt_version = excluded.prompt_version,
    api_key_configured = excluded.api_key_configured,
    api_key_hint = excluded.api_key_hint,
    updated_at = excluded.updated_at
  returning * into v_settings;

  return to_jsonb(v_settings);
end;
$$;

revoke all on function public.save_summarizer_configuration(
  uuid, uuid, boolean, integer, integer, integer, integer,
  text, text, text, text, text, text, integer, text, timestamptz
) from public, anon, authenticated;

grant execute on function public.save_summarizer_configuration(
  uuid, uuid, boolean, integer, integer, integer, integer,
  text, text, text, text, text, text, integer, text, timestamptz
) to service_role;
