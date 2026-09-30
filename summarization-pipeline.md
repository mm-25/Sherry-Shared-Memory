# Gate 6 Summarization and Memory Pipeline

Status: implementation complete; controlled live model validation remains

Current implementation note (September 2026): automatic claim extraction and conflict creation are retired. The summarizer now returns only a checkpoint summary, topics, cited decisions, and cited open threads. Historical claims and conflicts remain in storage but are not used for retrieval or new reviews. The sections below describing claims document the earlier pipeline, not an active workflow.

## Product outcome

The platform turns captured conversations into understandable, editable, source-backed summaries. It does this on the server; the browser extension only captures visible messages and never decides what becomes memory.

## Default schedule

- The scheduler wakes every five minutes and checks whether each workspace is due.
- Settings offers 5, 10, 30, and 60-minute quiet periods; the default is 10 minutes.
- An automatic checkpoint becomes eligible only after the **latest** new or revised capture in that conversation has been quiet for the selected period, regardless of message count.
- A manual summary ignores the quiet period. The scheduler's five-minute cadence can add up to five minutes of delay after the period expires.
- A checkpoint processes at most 100 new/revised events; any remainder becomes another job.

## What the summarizer receives

For each eligible conversation, the input packet contains:

1. The previous active checkpoint summary, if one exists.
2. Up to two preceding raw messages as continuity overlap.
3. Only messages created or revised since the prior checkpoint.
4. Conversation title, provider, source URL, and event identifiers.
5. Existing active claims for that conversation, so corrections reuse the same memory key instead of creating synonyms.
6. A strict output schema and instructions to distinguish facts from inference.

The previous summary provides long-term continuity without sending the entire transcript again. Overlap messages are context only; they are marked separately from new evidence and do not advance the checkpoint twice.

## Information-preserving summary policy

A checkpoint is an overview, not the sole retrieval source. It must name useful details rather than narrating only that the user "gave preferences" or "asked the assistant to remember something." Exact preferences, decisions, corrections, constraints, entities, and outcomes remain visible when supported by the source.

Provider-native memory and Shared Memory are separate systems. Asking ChatGPT, Claude, Gemini, or Grok to add or delete native memory does not delete or suppress the captured conversation in Shared Memory. Shared Memory deletion happens only through explicit product controls. A newer user correction replaces stale wording in the current checkpoint and should reuse the existing claim predicate so the conflict/supersession workflow can identify both values.

Future retrieval must rank and return relevant raw source excerpts alongside claims and checkpoints. A model-generated checkpoint improves continuity and context size, but it is never treated as a lossless replacement for the transcript.

## How “new” is detected

The server uses canonical Supabase event IDs as the high-water mark. It also records the included revision number for every event. An event is selected when either:

- its database ID is newer than the last successful checkpoint; or
- its revision is newer than the revision previously summarized.

This second rule handles an assistant response that was still streaming when an earlier checkpoint ran. Checkpoint state changes only after the model response and database write both succeed.

## Stored output

Each successful run creates:

- a `summarization_jobs` record containing inputs, status, attempts, model identity, tokens, estimated cost, and audit-safe errors;
- a versioned `checkpoints` record containing the rolling summary, topics, decisions, open threads, source range, and model metadata;
- `checkpoint_events` rows identifying every new or overlap event and the exact revision included;
- zero or more provisional `memory_claims`, each linked to supporting evidence through `memory_evidence`;
- optional `memory_conflicts` records when two claims from **different source chats** share a predicate and scope but have different stored values. This is a candidate for review, not proof of a semantic contradiction.

Old checkpoint versions remain available for audit. Normal retrieval uses the latest active version.

## User controls

Test Settings now lets the user:

- turn summarization on or off;
- choose the interval;
- choose Anthropic, OpenAI, Google Gemini, or xAI Grok and provide a model name;
- add, replace, or remove a test API key;
- run the next eligible conversation summary immediately;
- see a masked key hint, never the saved key;
- see token use, estimated cost, last run, and failures.

API keys are encrypted by the Worker before storage. Browser-readable settings contain only whether a key exists and a masked hint. Production will replace user-supplied keys with platform-managed model access.

## Editing and review

- A user edit creates a user-edited checkpoint version; it does not rewrite raw messages.
- A user can delete generated summary text independently from its transcript. The deleted checkpoint retains only its source cursor so the same old transcript is not silently summarized again.
- Proposed claims are saved automatically as `provisional`.
- Review uses **Yes**, **No**, and **Not sure** actions. Confirmation raises retrieval authority; rejection excludes the claim; uncertainty keeps it provisional.
- Different stored values for the same predicate and scope are considered only when the claims came from different chats. Summary revisions within one chat remain saved without entering the conflict queue. The user can keep the earlier value, keep the newer value, keep both, or defer; Gate 10 will improve semantic contradiction detection.
- Every claim decision and conflict resolution receives an append-only review-history entry.

## Implementation sequence

- [x] Schema, ownership rules, checkpoint lineage, and incremental selector.
- [x] Settings API and encrypted key storage.
- [x] Provider-neutral summarizer gateway and structured output validation for Anthropic, OpenAI, Google Gemini, and xAI Grok.
- [x] Scheduled/manual job creation and safe retries.
- [x] Atomic checkpoint persistence, provider-reported usage/cost accounting, and diagnostics.
- [x] Summary viewing, source inspection, versioned editing, and independent deletion.
- [x] Provisional claim generation, evidence links, review history, and conflict resolution.
- [ ] Live test on the existing five captured conversations.

## Execution safety

- Cloudflare's scheduler wakes every five minutes, but a workspace runs only when its selected interval is due and automatic summarization is enabled.
- Each run is claimed once in Supabase before a provider call. A second runner cannot claim the same pending job.
- The selected API key is decrypted only inside the Worker for that request and is never included in stored job data or diagnostics.
- Temporary provider failures retry after 30 seconds, then 60 seconds, with exponential backoff capped at 15 minutes and a maximum attempt count.
- A job left in `processing` for five minutes is treated as stale and safely returned to the retry path.
- Before saving, Supabase rechecks every source event revision. If source text changed during the model call, the result is skipped rather than attached to stale evidence.
- The checkpoint, source-event lineage, claims, evidence, usage, and completion diagnostic commit together. If any part fails, none of that result becomes the active memory.

## Exit test

Add messages to a previously summarized conversation, run the next checkpoint, and verify that the model receives the previous summary, two overlap messages, and only the changed events. The dashboard must show an understandable editable summary, exact source links, model usage, and no duplicate checkpoint work.
