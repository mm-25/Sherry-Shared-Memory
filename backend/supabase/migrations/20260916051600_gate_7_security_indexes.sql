revoke all on function public.create_default_memory_project() from public, anon, authenticated;
create index if not exists memory_notes_project_idx on public.memory_notes(project_id);
create index if not exists retrieval_requests_user_idx on public.retrieval_requests(user_id, created_at desc);
