alter table public.checkpoints
  add column previous_checkpoint_id uuid references public.checkpoints(id) on delete set null;

alter table public.checkpoint_events
  add column included_revision integer not null default 1,
  add constraint checkpoint_events_revision_positive check (included_revision > 0);

create index checkpoints_previous_checkpoint_idx on public.checkpoints (previous_checkpoint_id);
