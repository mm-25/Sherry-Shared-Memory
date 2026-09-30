# Shared Memory Policy — Draft v0.1

Status: working draft for review

## 1. Purpose

The shared memory layer gives a user-controlled, cross-platform context store for ChatGPT, Claude, Gemini, and future tools. It is a source-backed memory vault and retrieval service, not a replacement for provider-native chat or memory.

The raw record is preserved wherever permitted. Derived summaries and durable memories are separate records and never silently replace the source.

## 2. Memory authorities

| Authority | Meaning | How we handle it |
| --- | --- | --- |
| Provider-native | Memory held inside ChatGPT, Claude, or Gemini | Treat as opaque and provider-local; do not assume we can inspect or modify it |
| Current user instruction | What the user explicitly says now | Highest practical authority for resolving a personal fact or preference |
| User-authored shared memory | A note or memory the user explicitly confirms for reuse | Canonical for cross-platform use within its scope, but still traceable to evidence |
| Captured source | A message, document, or event captured from a connected source | Literal evidence; not automatically an atomic memory claim |
| Derived checkpoint/summary | A machine-generated synthesis of a defined captured range | Persistent retrieval context, but lower authority than its evidence |
| Inference | A conclusion generated from one or more sources | Never store as confirmed without user confirmation |

Provider system and safety instructions remain outside our control and always take precedence over connector data. Connector output is context, not an instruction to bypass provider rules.

## 3. Scopes

Every shared record has one scope:

- `personal`: user-wide context
- `work`: work-related context
- `project`: context for one project
- `workspace`: the user’s private tenant/container in the initial release; team sharing is deferred
- `provider_local`: intended for one provider only

The narrowest matching scope wins. A project record should not leak into another project. Sensitive records require explicit scope and permission; they are never made globally searchable by default.

## 4. What is collected

For an enabled connection, the default policy captures the visible conversation content and metadata needed for continuity:

- user messages and assistant responses
- timestamps, chat title, provider, canonical chat URL, and—where reliable—message-level anchors
- web-search result links shown in the conversation
- user-uploaded files, images, and attachments only when enabled in settings
- temporary chats only when explicitly enabled in settings
- explicit user notes and memory edits
- source and project metadata needed for organization and retrieval
- operational records such as sync cursors, indexing status, and audit events

Edited and deleted messages are not backfilled by the first capture implementation. The browser capture path records rendered content available to the extension. It does not claim access to hidden provider memory, system prompts, private model reasoning, or content outside the user-approved source.

The initial supported platforms are ChatGPT, Claude, and Gemini. Other platforms are future adapters, not an MVP promise.

## 5. Capture and promotion rules

Capture and durable-memory promotion are separate controls.

1. A source event may be captured as raw evidence.
2. The event is normalized and indexed, and may be included in a persistent checkpoint summary.
3. Checkpoint summaries are durable derived context and are retained independently from temporary raw events.
4. A durable memory claim is an atomic, reusable fact or preference. It may be created from a summary or source, but remains distinct from the summary and is not assumed to be error-free.
5. A durable memory claim is created automatically as a `provisional` claim. The user can later review it with `yes`, `no`, or `not sure`. A confirmed claim has higher retrieval priority; a rejected claim is excluded; `not sure` leaves it unresolved for later review.
6. A summary or memory claim never becomes the only copy of the underlying evidence while that evidence is retained.

The default policy is raw capture plus retrieval indexing and persistent checkpoint summarization for supported captured sources. Checkpoints run on a fixed schedule, defaulting to 10 minutes, with a user setting that can reduce the interval to 5 minutes or increase it for lower usage. Automatic provisional-claim creation is enabled by default.

For ChatGPT, Claude, and Gemini, capture is enabled by default after connection. The user can pause it, switch to manual-only mode, restrict it to selected sites, enable attachments, enable temporary chats, or remove a provider. A future custom platform requires a compatible site adapter; recognizing a URL alone is not enough to reliably identify and extract conversation content.

Cross-provider retrieval is enabled by default for the user’s private workspace after a provider is connected. A newly connected provider can retrieve existing shared memories immediately. The user can control which providers collect data and which providers may retrieve it.

The platform performs summarization rather than asking the active provider to maintain the shared memory. In the test build, Settings may select a model provider, model, and user-supplied API key. In a production release, this becomes a platform-managed service; any stored test key must be encrypted, masked, excluded from logs, and removable.

The summarizer receives only the new captured event IDs after the last successful checkpoint, plus a small overlap when needed for continuity. The browser extension does not decide what is a durable memory; it only captures visible events and stable identifiers. The server tracks the checkpoint cursor and schedules summarization.

## 6. Conflict handling

Conflicting claims are grouped; they are not silently merged or deleted.

Resolution order:

1. Current explicit user correction.
2. Exact scope match, with project-specific context preferred over general context.
3. User-authored and confirmed records preferred over captured or inferred records.
4. Stronger evidence and clearer provenance preferred over summaries.
5. Newer effective information preferred when authority and scope are otherwise equal.

When uncertainty remains, the retrieval response includes a conflict notice and both evidence references. The product may ask the user to confirm one claim, keep both as time-bound facts, or retract one. A superseded record remains auditable but is excluded from normal retrieval.

Users may edit a generated checkpoint summary. The edited version is stored as a user-edited derived record and does not rewrite the raw conversation. If a memory claim was created from the summary, the product shows that claim for separate review rather than silently changing it.

## 7. Retrieval policy

Retrieval is permission-filtered before ranking. The service should return the smallest useful context packet, not a dump of the user’s history.

Each returned item includes its scope, authority, status, timestamp, and evidence link. Context is grouped into:

- confirmed durable memories
- relevant project/work context
- relevant source excerpts
- unresolved conflicts or open threads

The provider is instructed to treat these items as user-provided reference data, preserve attribution, and surface material conflicts.

## 8. Retention and deletion

Raw events, derived checkpoints, durable memories, indexes, and audit records have independent retention policies. The default raw-event retention is 30 days. Users may increase it or choose `never delete`.

Checkpoint summaries and confirmed memory claims are retained until the user deletes or supersedes them. If raw evidence is deleted while a derived record is retained, the record is marked `source_unavailable` and cannot imply that its original evidence is still accessible. Users may also choose a full source deletion that removes or tombstones all derived records linked only to that source.

When the user chooses `never delete`, the product should explain that persistent summaries are intended to reduce the need for indefinite raw storage, but summaries are not infallible and retaining raw evidence improves auditability and correction.

Manual deletion offers three choices: delete the raw transcript only, delete the summary/derived records only, or delete both. The product warns that deleting raw evidence can make a retained summary harder to verify.

Deletion is auditable. A user can export their data, delete individual records, delete a source, disconnect a provider, or delete the account.

## 9. Security principles

- Never request or store provider passwords.
- Sensitivity categories are user-configurable in Settings, including financial, health, and other personal information. These categories are enabled by default and the user can disable them later.
- Passwords, API keys, credit-card numbers, and financial-account credentials/details remain hard-blocked from long-term storage by default; secret detection and redaction occur before raw content is written. The product can revisit this boundary only as an explicit security decision.
- Store OAuth refresh tokens only in encrypted secret storage; database rows contain references and metadata.
- Enforce tenant and scope permissions server-side, including for MCP requests.
- Treat captured content and retrieved documents as untrusted data to defend against prompt injection.
- Log access and mutations without logging secret tokens or unnecessary content.

## 10. Decisions still requiring product approval

- Whether automatic durable-claim promotion is available in the first release; persistent checkpoint summaries are in scope.
- Which health categories require an additional setting or warning before retention.
- Whether the test-build API-key/model controls should remain available to end users after launch.
