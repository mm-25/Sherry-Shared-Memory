# Shared Memory Data Model — Draft v0.1

Status: working draft for review

## 1. Design rule

The system stores evidence, organization metadata, and derived search material separately. Earlier versions also generated durable-claim and conflict records. That extraction workflow is retired for the current MVP: new claim inserts are blocked, and historical rows are not used in retrieval. The claim schema below is retained as architecture history, not a description of active behavior.

## 2. Core entities

Implementation note: Gate 4B now implements `devices` and `capture_adapters` plus structured provider-family, product, surface, capture-session, source-locator, and coverage fields across batches, conversations, events, and cursors. Existing Capture API v1 rows were backfilled; v1 remains accepted while clients move to v2. A fallback-identity reconciliation rule safely migrates one unambiguous legacy DOM identity to the deterministic sequence/role identity used when a provider exposes no stable message ID.

| Entity | Stores | Important relationships |
| --- | --- | --- |
| `users` | Account identity, preferences, data-control settings | Owns workspaces and personal records |
| `workspaces` | Private tenant boundary, plan, encryption/configuration settings | Contains one user initially; multi-user membership is reserved for a later release |
| `workspace_memberships` | Reserved membership model for future collaboration | Connects users to workspaces when sharing is introduced |
| `projects` | Name, description, scope, status, default retrieval rules | Groups conversations, documents, notes, and memories |
| `provider_connections` | Provider, external account ID, OAuth status, enabled scopes, capture mode, allowed domains, last sync | Connects a user/workspace to ChatGPT, Claude, Gemini, Perplexity, Drive, etc. |
| `devices` | Pseudonymous device ID, user/workspace, operating system, client version, last seen, trust/revocation status | Parent for browser, desktop, coding-agent, and Android capture clients |
| `capture_adapters` | Provider product, surface, adapter type/version, host app/package version, permissions, health, supported capabilities | Describes how one surface is captured and whether the adapter is working |
| `sources` | Origin identity, source type, title, canonical URL, URL availability, project, visibility, capture status | Parent for conversations and documents |
| `conversations` | Provider conversation ID, title, participants, canonical chat URL, optional message anchors, timestamps, sync state | Belongs to a source and contains events/checkpoints |
| `conversation_events` | Individual visible messages or event payloads, provider message ID, content hash, sequence, author, timestamps, raw-object pointer | Immutable evidence within a conversation; IDs and hashes support deduplication |
| `conversation_links` | Web-search result URLs, link titles, source message, and observed timestamp | Preserves useful links without storing full search pages |
| `documents` | File metadata, MIME type, checksum, source, current version | Has one or more document versions |
| `document_versions` | Immutable file/content version and object-store pointer | Parent for searchable chunks |
| `attachments` | Attachment metadata, MIME type, size, checksum, object-store pointer, capture/processing status | Linked to a conversation event; content capture is settings-controlled |
| `text_chunks` | Searchable excerpts, token count, offsets, metadata, embedding pointer | Derived from event or document content |
| `checkpoints` | Persistent incremental summaries, message ranges, topics, open threads, status, model metadata, source-availability state | Derived from a conversation range; links back to evidence |
| `notes` | User-authored notes, instructions, tags, scope, status | May be promoted to or linked with a memory claim |
| `memory_claims` | Atomic fact/preference/decision, value, scope, authority, confidence, effective dates, status, review state | Canonical cross-provider memory record; created provisionally and reviewed later |
| `memory_evidence` | Links a claim to events, documents, notes, or checkpoints | Explains why a claim exists |
| `memory_conflicts` | Conflict group, competing claims, resolution state, user decision | Connects contradictory claims |
| `permissions` | Subject, resource, actions, scope, expiry, consent record | Authorizes retrieval and mutation |
| `retention_policies` | Retention by record type/scope, legal hold, deletion behavior | Applies to workspace/project/user data |
| `capture_sessions` | Device/adapter session, enabled sources/apps, start/stop/pause, observed range, coverage state, gap state, queue health | Operational record for capture controls across browser, desktop, coding-agent, Android, share, and import clients |
| `import_batches` | Provider archive identity, parser version, date range, counts, failures, status, undo/deletion state | Groups historical imports so progress, provenance, deduplication, and undo remain auditable |
| `sync_cursors` | Provider/source cursor, last captured message ID/hash, gap/backfill state, last checkpoint ID | Makes ingestion and summarization incremental and idempotent |
| `indexing_jobs` | Operation, source range, status, retries, error, version | Tracks normalization, chunking, and indexing |
| `summarization_jobs` | New event IDs, checkpoint range, schedule, summarizer provider/model, token usage, estimated cost, status, output version | Tracks scheduled background summary generation and credit use |
| `retrieval_requests` | Request origin, scope, query hash, result IDs, latency, policy decision | Auditable context retrieval without storing excessive prompt content |
| `diagnostic_runs` | Test scenario, connection, expected result, start/end, status, failure summary | User-facing testing and integration verification |
| `diagnostic_events` | Capture, sync, indexing, summarization, retrieval, and connector events with latency/status | Shows what worked, what failed, and where data stopped flowing |
| `audit_events` | Who did what, to which resource, when, outcome | Immutable security and user-control trail |

Provider-native memories are not represented as ordinary `memory_claims` unless the user explicitly imports them. If imported, their source and authority remain `provider_import`.

## 2.1 Chat URL and source linking

Each captured conversation stores the provider’s canonical chat URL when available, along with the time it was observed and an optional message anchor. A memory result can link back to the conversation and show the exact message range used as evidence when the provider supports stable deep links. If a URL is unavailable, expired, changed, or requires a new login, the product shows the source metadata and evidence range instead of presenting a broken link.

Native applications may not expose a URL. In that case, the conversation stores a provider session ID or device-local source locator plus provider product, surface, originating device, and adapter provenance. Local locators are never presented as universal links; the product may offer “Open in app” only when the relevant operating system and provider support a safe deep link.

## 3. Canonical memory claim

An atomic claim should be representable as:

```json
{
  "claim_id": "mem_123",
  "subject": "user",
  "predicate": "works_at",
  "value": "Company X",
  "scope": {"type": "personal"},
  "authority": "user_confirmed",
  "status": "confirmed",
  "confidence": 1.0,
  "effective_from": "2026-03-01",
  "observed_at": "2026-09-13T00:00:00Z",
  "evidence_ids": ["evt_456"],
  "supersedes": ["mem_098"],
  "sensitivity": "normal"
}
```

The important distinction is between `observed_at` (when we saw the evidence) and `effective_from` (when the fact became true). Claims can also have `effective_to` for time-bounded facts.

## 4. Storage split

The first architecture should use:

- Supabase PostgreSQL for metadata, claims, permissions, statuses, search text, and audit records.
- Cloudflare R2 for raw event payloads, original files, and immutable versions.
- PostgreSQL full-text and metadata search for the first retrieval release.
- Optional vector embeddings later, stored with explicit model/version metadata and rebuild support.

Google Drive can be a user-controlled source or export destination, but it should not be the live retrieval database. The platform syncs Drive content into its index and preserves the Drive file ID and revision as provenance. Users can export raw and derived data to Drive or local files, but bring-your-own live storage is deferred.

## 5. Lifecycle

```text
captured source → normalized event/document → indexed chunks
                              ↓
                    persistent checkpoint
                              ↓
                proposed memory claim → confirmed claim
```

Every derived record keeps a pointer to its source and processing version. Reprocessing creates a new derived version rather than mutating the evidence.

## 6. Missing-link entities added to the original list

The minimum additions are `provider_connections`, `devices`, `capture_adapters`, `import_batches`, `memory_claims`, `memory_evidence`, `memory_conflicts`, `sync_cursors`, `summarization_jobs`, `diagnostic_runs`, `diagnostic_events`, and `retrieval_requests`. Without these, the system cannot distinguish cross-provider memory from raw captured data, explain conflicts, measure summarization usage, test the pipeline, reconcile cross-device capture, or reliably synchronize incrementally.

## 7. Open schema questions

- Should a memory claim support multiple simultaneous values, such as two jobs or residences?
- Which sensitive categories require encryption or explicit confirmation before indexing?
- How should the product behave when a provider URL changes, expires, or cannot deep-link to a specific message?
- Should a user’s custom platform require a dedicated site adapter, or can a generic capture mode be supported safely?
