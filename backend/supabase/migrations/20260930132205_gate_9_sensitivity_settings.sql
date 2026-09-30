-- Gate 9: workspace-level retrieval controls for explicitly labelled memory.
create table public.workspace_retrieval_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  financial_enabled boolean not null default true,
  health_enabled boolean not null default true,
  personal_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workspace_retrieval_settings enable row level security;
alter table public.workspace_retrieval_settings force row level security;
create policy workspace_retrieval_settings_owned on public.workspace_retrieval_settings
  for select to authenticated
  using (workspace_id in (select id from public.workspaces where owner_user_id = (select auth.uid())));
revoke all on public.workspace_retrieval_settings from anon, authenticated;
grant select on public.workspace_retrieval_settings to authenticated;
grant select, insert, update, delete on public.workspace_retrieval_settings to service_role;

create or replace function public.create_default_workspace_retrieval_settings()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.workspace_retrieval_settings(workspace_id) values (new.id);
  return new;
end;
$$;
drop trigger if exists workspaces_create_default_workspace_retrieval_settings on public.workspaces;
create trigger workspaces_create_default_workspace_retrieval_settings
after insert on public.workspaces for each row execute function public.create_default_workspace_retrieval_settings();
revoke all on function public.create_default_workspace_retrieval_settings() from public, anon, authenticated;

insert into public.workspace_retrieval_settings(workspace_id)
select id from public.workspaces
on conflict (workspace_id) do nothing;

-- Existing Personal Memory records need the same labels as newly saved records.
-- Finance and Health entries keep their own categories; every other Personal
-- Memory entry and category is treated as Personal until the user relabels it.
update public.memory_notes as note
set tags = array_append(note.tags,
  case
    when exists (select 1 from unnest(note.tags) as tag where lower(tag) in ('category:finance', 'category:financial')) then 'sensitivity:financial'
    when exists (select 1 from unnest(note.tags) as tag where lower(tag) = 'category:health') then 'sensitivity:health'
    else 'sensitivity:personal'
  end)
where 'sherry:personal' = any(note.tags)
  and not (note.tags && array['sensitivity:financial', 'sensitivity:health', 'sensitivity:personal']::text[]);
