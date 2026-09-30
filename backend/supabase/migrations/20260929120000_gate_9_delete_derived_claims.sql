-- Historical claims contain derived conversation content. Remove them with their
-- source conversation; their evidence and conflict rows cascade from the claim.
grant delete on public.conversations, public.memory_claims to service_role;

-- Earlier conversation deletions could null this foreign key and cascade the
-- evidence, leaving derived text with no inspectable source. Remove only those
-- source-less historical rows; active claim generation is already retired.
delete from public.memory_claims claim
where claim.conversation_id is null
  and claim.authority = 'derived'
  and not exists (
    select 1 from public.memory_evidence evidence
    where evidence.memory_claim_id = claim.id
  );

create or replace function public.delete_conversation_claims()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.memory_claims
  where workspace_id = old.workspace_id and conversation_id = old.id;
  return old;
end;
$$;
revoke all on function public.delete_conversation_claims() from public, anon, authenticated;

drop trigger if exists conversations_delete_claims on public.conversations;
create trigger conversations_delete_claims
before delete on public.conversations for each row
execute function public.delete_conversation_claims();
