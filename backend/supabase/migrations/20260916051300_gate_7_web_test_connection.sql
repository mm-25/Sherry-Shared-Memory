alter table public.retrieval_connections
  drop constraint retrieval_connections_provider_allowed,
  add constraint retrieval_connections_provider_allowed
    check (provider in ('chatgpt', 'claude', 'gemini', 'grok', 'generic', 'web_test'));
