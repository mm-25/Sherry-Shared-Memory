-- This trigger runs only when Postgres writes a conversation. It is not an API.
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default, which
-- otherwise exposes a SECURITY DEFINER trigger function through PostgREST.
revoke execute on function public.reject_recapture_of_deleted_conversation()
  from public, anon, authenticated;
