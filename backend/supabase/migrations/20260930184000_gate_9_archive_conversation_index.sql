-- Keep every raw batch discoverable when its conversation is deleted, including
-- batches whose messages were all duplicates and produced no conversation_events.
alter table public.ingestion_batches
  add column if not exists provider_conversation_ids text[];

-- Existing event-backed batches can be indexed from their committed events.
-- A null value is intentional for legacy duplicate-only batches: the Worker
-- reads those archives during deletion to check whether they contain the chat.
update public.ingestion_batches as batch
set provider_conversation_ids = indexed.conversation_ids
from (
  select ingestion_batch_id, array_agg(distinct provider_conversation_id order by provider_conversation_id) as conversation_ids
  from public.conversation_events
  group by ingestion_batch_id
) as indexed
where batch.id = indexed.ingestion_batch_id
  and batch.provider_conversation_ids is null;

comment on column public.ingestion_batches.provider_conversation_ids is
  'Source conversation IDs in this raw archive; null means legacy or unindexed and must be inspected on deletion.';

-- A scheduled repair finishes archive cleanup if deletion was interrupted
-- after the tombstone was written, and repairs older deletion remnants.
alter table public.deleted_conversations
  add column if not exists archive_reconciled_at timestamptz;

create index if not exists deleted_conversations_unreconciled_idx
  on public.deleted_conversations (deleted_at, id)
  where archive_reconciled_at is null;

-- The Worker checks tombstones before uploading. This database guard closes
-- the race where deletion happens after that check but before ingestion commits.
create or replace function public.reject_recapture_of_deleted_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.deleted_conversations as deleted
    where deleted.workspace_id = new.workspace_id
      and deleted.provider = new.provider
      and deleted.provider_conversation_id = new.provider_conversation_id
  ) then
    raise exception 'deleted_conversation_recapture_blocked';
  end if;
  return new;
end;
$$;

drop trigger if exists conversations_reject_deleted_recapture on public.conversations;
create trigger conversations_reject_deleted_recapture
  before insert or update on public.conversations
  for each row execute function public.reject_recapture_of_deleted_conversation();
