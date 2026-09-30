create index summarizer_secrets_updated_by_idx on public.summarizer_secrets (updated_by);

create policy summarizer_secrets_deny_browser_access on public.summarizer_secrets
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);
