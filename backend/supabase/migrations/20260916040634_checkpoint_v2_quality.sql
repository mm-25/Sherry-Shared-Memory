update public.summarizer_settings
set prompt_version = 'checkpoint-v2',
    updated_at = now()
where prompt_version = 'checkpoint-v1';
