create table public.deleted_conversations (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  provider_conversation_id text not null,
  deleted_at timestamptz not null default now(),
  constraint deleted_conversations_provider_allowed check (provider in ('chatgpt', 'claude', 'gemini')),
  constraint deleted_conversations_unique unique (workspace_id, provider, provider_conversation_id)
);

create index deleted_conversations_workspace_idx on public.deleted_conversations (workspace_id, deleted_at desc);

alter table public.deleted_conversations enable row level security;
alter table public.deleted_conversations force row level security;

create policy deleted_conversations_select_owned_workspace on public.deleted_conversations
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = deleted_conversations.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

revoke all on public.deleted_conversations from anon, authenticated;
grant select on public.deleted_conversations to authenticated;
