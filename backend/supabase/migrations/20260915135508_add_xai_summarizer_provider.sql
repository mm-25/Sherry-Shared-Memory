alter table public.summarizer_settings
  drop constraint summarizer_settings_provider_allowed,
  add constraint summarizer_settings_provider_allowed
    check (provider in ('anthropic', 'openai', 'google', 'xai'));

alter table public.summarizer_secrets
  drop constraint summarizer_secrets_provider_allowed,
  add constraint summarizer_secrets_provider_allowed
    check (provider in ('anthropic', 'openai', 'google', 'xai'));

alter table public.summarization_jobs
  drop constraint summarization_jobs_provider_allowed,
  add constraint summarization_jobs_provider_allowed
    check (provider in ('anthropic', 'openai', 'google', 'xai'));

alter table public.checkpoints
  drop constraint checkpoints_provider_allowed,
  add constraint checkpoints_provider_allowed
    check (provider in ('anthropic', 'openai', 'google', 'xai'));
