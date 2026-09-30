create table public.summarizer_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  enabled boolean not null default true,
  interval_minutes integer not null default 10,
  min_new_events integer not null default 2,
  max_single_event_wait_minutes integer not null default 30,
  continuity_overlap_events integer not null default 2,
  provider text not null default 'anthropic',
  model text,
  prompt_version text not null default 'checkpoint-v1',
  api_key_configured boolean not null default false,
  api_key_hint text,
  last_scheduled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint summarizer_settings_interval_allowed check (interval_minutes in (5, 10, 30, 60)),
  constraint summarizer_settings_min_new_events_allowed check (min_new_events between 1 and 100),
  constraint summarizer_settings_single_event_wait_allowed check (max_single_event_wait_minutes between 5 and 1440),
  constraint summarizer_settings_overlap_allowed check (continuity_overlap_events between 0 and 20),
  constraint summarizer_settings_provider_allowed check (provider in ('anthropic', 'openai', 'google')),
  constraint summarizer_settings_model_not_blank check (model is null or char_length(btrim(model)) between 1 and 160),
  constraint summarizer_settings_key_hint_safe check (api_key_hint is null or char_length(api_key_hint) between 4 and 24)
);

create table public.summarizer_secrets (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  provider text not null,
  key_ciphertext text not null,
  key_iv text not null,
  key_version integer not null default 1,
  updated_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint summarizer_secrets_provider_allowed check (provider in ('anthropic', 'openai', 'google')),
  constraint summarizer_secrets_key_version_positive check (key_version > 0),
  constraint summarizer_secrets_ciphertext_not_blank check (char_length(key_ciphertext) > 20),
  constraint summarizer_secrets_iv_not_blank check (char_length(key_iv) > 8)
);

create table public.summarization_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  reason text not null default 'scheduled',
  status text not null default 'pending',
  scheduled_for timestamptz not null default now(),
  eligible_after timestamptz not null default now(),
  new_event_ids bigint[] not null,
  overlap_event_ids bigint[] not null default '{}'::bigint[],
  first_new_event_id bigint references public.conversation_events(id) on delete set null,
  last_new_event_id bigint references public.conversation_events(id) on delete set null,
  provider text not null,
  model text not null,
  prompt_version text not null,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  claimed_at timestamptz,
  completed_at timestamptz,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(12, 6),
  provider_request_id text,
  model_version text,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint summarization_jobs_reason_allowed check (reason in ('scheduled', 'manual', 'retry', 'backfill')),
  constraint summarization_jobs_status_allowed check (status in ('pending', 'processing', 'completed', 'failed', 'skipped')),
  constraint summarization_jobs_provider_allowed check (provider in ('anthropic', 'openai', 'google')),
  constraint summarization_jobs_new_events_not_empty check (cardinality(new_event_ids) between 1 and 100),
  constraint summarization_jobs_overlap_bounded check (cardinality(overlap_event_ids) between 0 and 20),
  constraint summarization_jobs_attempts_valid check (attempt_count >= 0 and max_attempts between 1 and 10),
  constraint summarization_jobs_tokens_nonnegative check (
    (input_tokens is null or input_tokens >= 0) and
    (output_tokens is null or output_tokens >= 0)
  ),
  constraint summarization_jobs_cost_nonnegative check (estimated_cost_usd is null or estimated_cost_usd >= 0)
);

create unique index summarization_jobs_one_active_per_conversation_idx
  on public.summarization_jobs (conversation_id)
  where status in ('pending', 'processing');

create index summarization_jobs_pending_schedule_idx
  on public.summarization_jobs (eligible_after, created_at)
  where status = 'pending';

create index summarization_jobs_workspace_created_idx
  on public.summarization_jobs (workspace_id, created_at desc);

create index summarization_jobs_first_new_event_idx
  on public.summarization_jobs (first_new_event_id);

create index summarization_jobs_last_new_event_idx
  on public.summarization_jobs (last_new_event_id);

create table public.checkpoints (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  summarization_job_id uuid references public.summarization_jobs(id) on delete set null,
  version integer not null,
  first_event_id bigint references public.conversation_events(id) on delete set null,
  last_event_id bigint references public.conversation_events(id) on delete set null,
  source_event_ids bigint[] not null,
  summary_text text not null,
  topics text[] not null default '{}'::text[],
  open_threads jsonb not null default '[]'::jsonb,
  key_decisions jsonb not null default '[]'::jsonb,
  status text not null default 'active',
  source_availability text not null default 'available',
  provider text not null,
  model text not null,
  model_version text,
  prompt_version text not null,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(12, 6),
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint checkpoints_version_positive check (version > 0),
  constraint checkpoints_source_events_not_empty check (cardinality(source_event_ids) between 1 and 120),
  constraint checkpoints_summary_not_blank check (char_length(btrim(summary_text)) > 0),
  constraint checkpoints_status_allowed check (status in ('active', 'user_edited', 'superseded', 'deleted')),
  constraint checkpoints_source_availability_allowed check (source_availability in ('available', 'partial', 'unavailable')),
  constraint checkpoints_provider_allowed check (provider in ('anthropic', 'openai', 'google')),
  constraint checkpoints_tokens_nonnegative check (
    (input_tokens is null or input_tokens >= 0) and
    (output_tokens is null or output_tokens >= 0)
  ),
  constraint checkpoints_cost_nonnegative check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  constraint checkpoints_conversation_version_unique unique (conversation_id, version),
  constraint checkpoints_job_unique unique (summarization_job_id)
);

create index checkpoints_workspace_created_idx on public.checkpoints (workspace_id, created_at desc);
create index checkpoints_conversation_version_idx on public.checkpoints (conversation_id, version desc);
create index checkpoints_first_event_idx on public.checkpoints (first_event_id);
create index checkpoints_last_event_idx on public.checkpoints (last_event_id);

create table public.checkpoint_events (
  checkpoint_id uuid not null references public.checkpoints(id) on delete cascade,
  conversation_event_id bigint not null references public.conversation_events(id) on delete cascade,
  inclusion_type text not null,
  position integer not null,
  primary key (checkpoint_id, conversation_event_id),
  constraint checkpoint_events_inclusion_allowed check (inclusion_type in ('new', 'overlap')),
  constraint checkpoint_events_position_nonnegative check (position >= 0)
);

create index checkpoint_events_event_id_idx on public.checkpoint_events (conversation_event_id);

create table public.memory_claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  subject text not null default 'user',
  predicate text not null,
  value jsonb not null,
  display_text text not null,
  scope_type text not null default 'workspace',
  scope_ref text,
  authority text not null default 'derived',
  status text not null default 'provisional',
  review_state text not null default 'unreviewed',
  confidence numeric(4, 3) not null,
  observed_at timestamptz not null,
  effective_from timestamptz,
  effective_to timestamptz,
  sensitivity text not null default 'normal',
  source_availability text not null default 'available',
  supersedes_claim_id uuid references public.memory_claims(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  constraint memory_claims_predicate_not_blank check (char_length(btrim(predicate)) between 1 and 120),
  constraint memory_claims_display_not_blank check (char_length(btrim(display_text)) > 0),
  constraint memory_claims_scope_allowed check (scope_type in ('personal', 'work', 'project', 'workspace', 'provider_local')),
  constraint memory_claims_authority_allowed check (authority in ('derived', 'captured', 'user_authored', 'user_confirmed', 'provider_import')),
  constraint memory_claims_status_allowed check (status in ('provisional', 'confirmed', 'rejected', 'superseded', 'deleted')),
  constraint memory_claims_review_allowed check (review_state in ('unreviewed', 'yes', 'no', 'not_sure')),
  constraint memory_claims_confidence_range check (confidence between 0 and 1),
  constraint memory_claims_effective_range check (effective_to is null or effective_from is null or effective_to >= effective_from),
  constraint memory_claims_sensitivity_allowed check (sensitivity in ('normal', 'financial', 'health', 'personal', 'restricted')),
  constraint memory_claims_source_availability_allowed check (source_availability in ('available', 'partial', 'unavailable'))
);

create index memory_claims_workspace_status_idx on public.memory_claims (workspace_id, status, updated_at desc);
create index memory_claims_conversation_idx on public.memory_claims (conversation_id);
create index memory_claims_supersedes_idx on public.memory_claims (supersedes_claim_id);

create table public.memory_evidence (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  memory_claim_id uuid not null references public.memory_claims(id) on delete cascade,
  conversation_event_id bigint references public.conversation_events(id) on delete cascade,
  checkpoint_id uuid references public.checkpoints(id) on delete cascade,
  evidence_role text not null default 'supports',
  created_at timestamptz not null default now(),
  constraint memory_evidence_exactly_one_source check (
    (conversation_event_id is not null and checkpoint_id is null) or
    (conversation_event_id is null and checkpoint_id is not null)
  ),
  constraint memory_evidence_role_allowed check (evidence_role in ('supports', 'contradicts', 'supersedes')),
  constraint memory_evidence_claim_event_unique unique (memory_claim_id, conversation_event_id),
  constraint memory_evidence_claim_checkpoint_unique unique (memory_claim_id, checkpoint_id)
);

create index memory_evidence_workspace_idx on public.memory_evidence (workspace_id);
create index memory_evidence_event_idx on public.memory_evidence (conversation_event_id);
create index memory_evidence_checkpoint_idx on public.memory_evidence (checkpoint_id);

create table public.memory_conflicts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  left_claim_id uuid not null references public.memory_claims(id) on delete cascade,
  right_claim_id uuid not null references public.memory_claims(id) on delete cascade,
  status text not null default 'unresolved',
  resolution text,
  resolved_claim_id uuid references public.memory_claims(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memory_conflicts_distinct_claims check (left_claim_id <> right_claim_id),
  constraint memory_conflicts_status_allowed check (status in ('unresolved', 'resolved', 'dismissed')),
  constraint memory_conflicts_pair_unique unique (left_claim_id, right_claim_id)
);

create index memory_conflicts_workspace_status_idx on public.memory_conflicts (workspace_id, status, created_at desc);
create index memory_conflicts_left_claim_idx on public.memory_conflicts (left_claim_id);
create index memory_conflicts_right_claim_idx on public.memory_conflicts (right_claim_id);
create index memory_conflicts_resolved_claim_idx on public.memory_conflicts (resolved_claim_id);

alter table public.summarizer_settings enable row level security;
alter table public.summarizer_settings force row level security;
alter table public.summarizer_secrets enable row level security;
alter table public.summarizer_secrets force row level security;
alter table public.summarization_jobs enable row level security;
alter table public.summarization_jobs force row level security;
alter table public.checkpoints enable row level security;
alter table public.checkpoints force row level security;
alter table public.checkpoint_events enable row level security;
alter table public.checkpoint_events force row level security;
alter table public.memory_claims enable row level security;
alter table public.memory_claims force row level security;
alter table public.memory_evidence enable row level security;
alter table public.memory_evidence force row level security;
alter table public.memory_conflicts enable row level security;
alter table public.memory_conflicts force row level security;

create policy summarizer_settings_select_owned_workspace on public.summarizer_settings
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = summarizer_settings.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy summarizer_settings_insert_owned_workspace on public.summarizer_settings
  for insert to authenticated
  with check (exists (
    select 1 from public.workspaces
    where workspaces.id = summarizer_settings.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy summarizer_settings_update_owned_workspace on public.summarizer_settings
  for update to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = summarizer_settings.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.workspaces
    where workspaces.id = summarizer_settings.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy summarization_jobs_select_owned_workspace on public.summarization_jobs
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = summarization_jobs.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy checkpoints_select_owned_workspace on public.checkpoints
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = checkpoints.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy checkpoint_events_select_owned_workspace on public.checkpoint_events
  for select to authenticated
  using (exists (
    select 1 from public.checkpoints
    join public.workspaces on workspaces.id = checkpoints.workspace_id
    where checkpoints.id = checkpoint_events.checkpoint_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy memory_claims_select_owned_workspace on public.memory_claims
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = memory_claims.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy memory_evidence_select_owned_workspace on public.memory_evidence
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = memory_evidence.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

create policy memory_conflicts_select_owned_workspace on public.memory_conflicts
  for select to authenticated
  using (exists (
    select 1 from public.workspaces
    where workspaces.id = memory_conflicts.workspace_id
      and workspaces.owner_user_id = (select auth.uid())
  ));

revoke all on public.summarizer_settings from anon, authenticated;
revoke all on public.summarizer_secrets from anon, authenticated;
revoke all on public.summarization_jobs from anon, authenticated;
revoke all on public.checkpoints from anon, authenticated;
revoke all on public.checkpoint_events from anon, authenticated;
revoke all on public.memory_claims from anon, authenticated;
revoke all on public.memory_evidence from anon, authenticated;
revoke all on public.memory_conflicts from anon, authenticated;

grant select on public.summarizer_settings to authenticated;
grant insert (workspace_id, enabled, interval_minutes, min_new_events, max_single_event_wait_minutes, continuity_overlap_events, provider, model, prompt_version)
  on public.summarizer_settings to authenticated;
grant update (enabled, interval_minutes, min_new_events, max_single_event_wait_minutes, continuity_overlap_events, provider, model, prompt_version, updated_at)
  on public.summarizer_settings to authenticated;
grant select on public.summarization_jobs to authenticated;
grant select on public.checkpoints to authenticated;
grant select on public.checkpoint_events to authenticated;
grant select on public.memory_claims to authenticated;
grant select on public.memory_evidence to authenticated;
grant select on public.memory_conflicts to authenticated;
