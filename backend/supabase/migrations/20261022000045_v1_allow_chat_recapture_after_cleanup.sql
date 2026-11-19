-- V1 deletion removes the current copy; completed cleanup is not a source ban.
-- Keep the record so retries can distinguish old cleanup from a later copy.
alter table public.deleted_conversations
  add column operation_id uuid not null default gen_random_uuid(),
  add column archive_cleanup_keys text[];

create or replace function public.reject_recapture_of_deleted_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.deleted_conversations as deleted
    where deleted.workspace_id = new.workspace_id
      and deleted.provider = new.provider
      and deleted.provider_conversation_id = new.provider_conversation_id
      and deleted.archive_reconciled_at is null
  ) then
    raise exception 'conversation_deletion_cleanup_pending';
  end if;
  return new;
end;
$$;
revoke execute on function public.reject_recapture_of_deleted_conversation()
  from public, anon, authenticated;

-- Serialize a deletion boundary against ingestion for this same source.
create function public.lock_conversation_deletion_boundary()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    new.workspace_id::text || ':' || new.provider || ':' || new.provider_conversation_id, 0));
  return new;
end;
$$;
revoke execute on function public.lock_conversation_deletion_boundary()
  from public, anon, authenticated;
create trigger deleted_conversations_lock_boundary
before insert or update on public.deleted_conversations
for each row execute function public.lock_conversation_deletion_boundary();

-- All capture RPC variants delegate to this function. Legacy callers retain
-- the temporary pending-cleanup guard; the new Worker also supplies the exact
-- observed deletion operation so a late pre-deletion request cannot commit.
do $migration$
declare
  definition text;
  anchor text := E'    v_provider_conversation_id := btrim(v_event->>''conversationId'');';
  boundary_check text := E'\n    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(\n      p_workspace_id::text || '':'' || p_provider || '':'' || v_provider_conversation_id, 0));\n    if v_event ? ''_sherryDeletionOperation'' and\n      (v_event->>''_sherryDeletionOperation'') is distinct from coalesce((\n        select d.operation_id::text from public.deleted_conversations d\n        where d.workspace_id = p_workspace_id and d.provider = p_provider\n          and d.provider_conversation_id = v_provider_conversation_id\n      ), ''initial'') then\n      raise exception ''capture_deletion_boundary_changed'';\n    end if;';
begin
  select pg_get_functiondef(
    'public.ingest_capture_batch(uuid,uuid,uuid,text,text,text,text,bigint,jsonb,jsonb)'::regprocedure
  ) into definition;
  if strpos(definition, anchor) = 0 then
    raise exception 'ingestion deletion-boundary anchor not found';
  end if;
  execute replace(definition, anchor, anchor || boundary_check);
end;
$migration$;

comment on column public.deleted_conversations.operation_id is
  'Identity of this deletion operation. Completed records permit new capture; cleanup updates must match this identity.';
comment on column public.deleted_conversations.archive_cleanup_keys is
  'Frozen old archive keys for this deletion. Late retries must not discover and erase newer recaptured copies.';
