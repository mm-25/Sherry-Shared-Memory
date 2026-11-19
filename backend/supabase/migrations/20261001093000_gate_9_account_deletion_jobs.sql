-- A deletion job must outlive the workspace and Auth user it removes.
create table public.account_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  workspace_id uuid not null unique,
  requested_at timestamptz not null default now(),
  auth_deleted_at timestamptz,
  completed_at timestamptz,
  next_check_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  attempt_count integer not null default 0,
  last_error text,
  constraint account_deletion_jobs_user_unique unique (user_id)
);

create index account_deletion_jobs_next_check_idx on public.account_deletion_jobs (next_check_at);
alter table public.account_deletion_jobs enable row level security;
revoke all on table public.account_deletion_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.account_deletion_jobs to service_role;

-- Insert the durable job and remove all workspace-scoped database rows in one transaction.
-- The Worker alone may call this function after authenticating the account owner.
create or replace function public.request_account_deletion(p_user_id uuid, p_workspace_id uuid)
returns public.account_deletion_jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.account_deletion_jobs;
begin
  if not exists (
    select 1 from public.workspaces
    where id = p_workspace_id and owner_user_id = p_user_id
  ) then
    raise exception 'Workspace does not belong to this user';
  end if;

  insert into public.account_deletion_jobs (user_id, workspace_id)
  values (p_user_id, p_workspace_id)
  returning * into v_job;

  delete from public.workspaces
  where id = p_workspace_id and owner_user_id = p_user_id;

  return v_job;
end;
$$;

revoke all on function public.request_account_deletion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_account_deletion(uuid, uuid) to service_role;

-- A user may still hold an unexpired access token while external cleanup runs.
-- Do not allow it to open a new workspace during account removal.
create or replace function public.reject_workspace_for_deleting_account()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.account_deletion_jobs where user_id = new.owner_user_id) then
    raise exception 'account_deletion_in_progress';
  end if;
  return new;
end;
$$;

create trigger workspaces_reject_deleting_account
  before insert or update of owner_user_id on public.workspaces
  for each row execute function public.reject_workspace_for_deleting_account();

revoke all on function public.reject_workspace_for_deleting_account() from public, anon, authenticated;
