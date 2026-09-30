# Technical Architecture — Draft v0.1

Status: Gate 2 working draft

## 1. Architecture in one sentence

Surface-specific capture clients observe or receive authorized conversation events and upload one normalized contract to a cloud ingestion service; Supabase stores the structured index and permissions, Cloudflare R2 stores raw content, background jobs create summaries and provisional memory claims, and an MCP service returns approved context to connected AI tools.

## 2. End-to-end flow

```text
Browser pages · desktop apps · coding agents · Android · provider exports
            ↓
WebExtensions · OS companion · hooks/session adapters · Android service · importers
            ↓  small authenticated event batches
Cloudflare Worker ingestion API
            ↓
Supabase metadata + search       Cloudflare R2 raw objects
            ↓                               ↓
Background jobs: indexing → summaries → provisional memory claims
            ↓
Permission-filtered retrieval service / MCP
            ↓
ChatGPT / Claude / Gemini connector
```

Capture clients are not the memory database. They are scoped sensors, structured integrations, and uploaders. The cloud services own the durable state.

## 3. Main components

| Component | Responsibility |
| --- | --- |
| Web application | Account, projects, sources, memory review, Settings, Diagnostics, export, and deletion |
| Browser extension | Detect supported pages, read visible messages, track lightweight cursors, and upload batches |
| Site adapters | Provider-specific logic for ChatGPT, Claude, and Gemini page structure and navigation |
| Desktop capture companion | Hosts macOS Accessibility, Windows UI Automation, coding-agent hook/session adapters, local encrypted queues, permissions, pause, and health reporting |
| Android capture client | Hosts the allow-listed Accessibility Service, Share Sheet integration, local encrypted queue, capture controls, and diagnostics |
| Structured agent adapters | Consume Codex, Claude Code, and Antigravity hooks, plugins, or local session events when available |
| Historical importers | Parse official provider archives, preview coverage, deduplicate records, and preserve import-batch provenance |
| Cloudflare Workers | Authenticated ingestion, API routing, rate limits, and MCP request handling |
| Supabase Auth | Platform account sign-in and session management |
| Supabase PostgreSQL | Users, private workspaces, projects, metadata, claims, permissions, search text, jobs, and audit records |
| Cloudflare R2 | Raw conversation events, original files, attachment objects, and immutable versions |
| Background job runner | Deduplication, indexing, checkpoint scheduling, summarization, redaction, deletion, and retries |
| Summarizer gateway | Converts one source packet and memory schema into provider-specific requests for Anthropic, OpenAI, Google Gemini, or xAI Grok; validates evidence, normalizes usage, and returns checkpoint output |
| MCP service | Returns a small permission-filtered context packet and performs explicit memory actions |

## 4. Why two storage systems are needed

R2 is suited to large, inexpensive files such as raw transcripts and attachments. Supabase is suited to structured records that need fast filtering, permissions, search, and relationships.

The user normally searches the Supabase-backed index. The system fetches from R2 only when it needs the original evidence or an export. This avoids making Google Drive or another file store part of every retrieval request.

## 5. Capture flow

1. The user connects a supported provider/device and grants only the required site, application, hook, file, or accessibility permission.
2. The selected adapter identifies the provider, product, surface, application version, and current conversation using a provider ID, URL, structured session ID, or derived local source locator.
3. The adapter reads visible user and assistant messages or receives their structured completion events.
4. Each event receives a provider message ID when available, otherwise a content hash and sequence number.
5. The capture client attaches adapter/device/coverage metadata, batches new events, and uploads them asynchronously.
6. The ingestion API authenticates the request and validates the event shape.
7. The server redacts credentials that must not be stored, deduplicates the batch, writes raw data to R2, and writes metadata to Supabase.
8. The server advances the cursor only after storage succeeds.

Capture clients should not repeatedly scan an entire interface, upload raw accessibility trees or unrelated windows, summarize content, run a vector database, or block the host application while waiting for uploads.

The complete surface matrix, adapter precedence, required scenarios, and proof criteria are defined in [`cross-platform-capture.md`](cross-platform-capture.md). MCP is used for retrieval and explicit writes; it is not considered comprehensive capture unless a host guarantees a write event for every completed turn.

## 6. Checkpoint and memory flow

The server maintains a checkpoint cursor for each conversation. By default, a checkpoint job runs every 10 minutes, with a user setting for a shorter 5-minute interval or a longer interval.

1. The job finds events after the previous checkpoint.
2. It adds a small overlap from the previous checkpoint for continuity.
3. The summarizer produces a persistent checkpoint summary linked to exact event IDs.
4. The memory extractor proposes atomic claims from the new evidence.
5. Provisional claims appear in the user’s review queue.
6. The user selects Yes, No, or Not sure.
7. Confirmed claims receive stronger retrieval priority; rejected claims are excluded; uncertain claims remain available for later review.

## 7. Retrieval flow

1. An AI tool calls the MCP service.
2. The service authenticates the connection and identifies the user and private workspace.
3. It applies provider, project, sensitivity, retention, and permission rules.
4. It applies the user's retrieval context budgets: maximum text characters, attachment count, and attachment size, subject to the connected provider's stricter limits.
5. It searches claims, summaries, notes, and source excerpts in Supabase.
6. It ranks results by scope, authority, status, evidence quality, freshness, and relevance.
7. It adds conflicts and source links where necessary.
8. It returns a compact context packet with provenance, selected attachments, and truncation information.

The retrieval service does not search Google Drive live during a normal request.

### 7.1 Relationship graph projection

Connected Conversations is a derived graph view, not a second memory database. The authoritative records remain conversations, events, summaries, claims, providers, and source links in Supabase/R2. A graph projection converts those records into typed nodes and edges:

- Nodes: workspace memory, providers, conversations, topics, claims, people, projects, and artifacts.
- Edges: captured-from, mentioned-in, supports, contradicts, belongs-to-project, references, and supersedes.
- Every graph node keeps the source record ID; every inferred edge keeps provenance, confidence, and the indexing version that produced it.
- Deleting or reprocessing an authoritative record rebuilds its graph projection instead of leaving an independent copy behind.

The web client uses Cytoscape.js for graph rendering, force-directed layout, selection, pan, and zoom. The server should eventually return a bounded graph neighborhood for the selected node rather than sending the entire workspace graph. This follows the useful architectural principle behind tools such as Obsidian: relationships are computed from stable source entities, while the visual graph remains an explorable projection of those entities.

## 8. Authentication and secrets

- Users sign into the platform through Supabase Auth. The extension sends a short-lived user session token to the ingestion Worker.
- Provider connections use OAuth or the provider’s supported connection method; provider passwords are never requested.
- Test summarizer API keys are stored encrypted, displayed masked, excluded from logs, and removable from Settings.
- The Worker validates the user session with the Supabase publishable key, then uses a Worker-only Supabase secret for the protected ingestion transaction. That secret is never shipped to the browser. The transaction separately verifies workspace ownership.
- User-facing database reads use row-level security and workspace-scoped queries. Direct client writes to captured evidence remain disabled so clients cannot bypass server validation and redaction.
- MCP tokens are short-lived or revocable and are limited to the user’s selected provider/project scopes.

## 9. Reliability and failure behavior

- Uploads use idempotency keys so retries do not duplicate events.
- Cursors advance only after successful writes.
- Missed visible messages trigger a backfill comparison using IDs, hashes, and sequence order.
- Failed summaries remain retryable and do not create duplicate checkpoints.
- If retrieval uses a stale index, the response says so.
- If a source URL cannot be opened, the product shows the stored evidence range instead.
- If the browser is offline, the extension queues a limited batch and reports its state in Diagnostics.
- Desktop and Android clients use bounded encrypted local queues and expose pending, failed, and quarantined events.
- Every adapter reports complete-observed-range, partial, gap-detected, fallback-only, or unsupported coverage.
- Cross-device reconciliation merges the same provider conversation using provider IDs where available and content/time/sequence evidence where they are not.
- Application or OS permission changes stop capture safely and create a visible diagnostic event.
- Provider UI/app-version changes that break extraction produce an explicit adapter-health failure rather than silent data loss.

## 10. Cost controls

- Store large raw content in R2 rather than the database.
- Store only searchable excerpts and metadata in the first index.
- Summarize only new messages after the last checkpoint.
- Cap summary size and frequency.
- Track model tokens, estimated cost, and failed/retried jobs.
- Defer embeddings until keyword search quality has been measured.
- Let users choose longer checkpoint intervals to reduce model usage.

## 11. Technical questions to answer with prototypes

These are experiments, not product decisions:

- Which visible page elements reliably contain messages on each provider?
- Do provider message IDs remain stable across reloads?
- How are temporary chats represented in each provider’s URL and page state?
- Which chat URLs remain usable after the user navigates away or logs in again?
- What is the extension’s CPU, memory, and network impact on long chats?
- Which summarizer model produces the best useful context per unit cost?
- How should the system handle several open tabs for the same conversation?
- Which desktop applications expose usable text and author roles through macOS Accessibility and Windows UI Automation?
- Which structured hooks/session records can guarantee completed-turn capture for Codex and Claude Code?
- Does Antigravity expose a stable plugin, hook, or session event suitable for automatic capture?
- Which Android applications expose complete message text and roles through their accessibility trees?
- How should cloud-synchronized conversations be reconciled across web, desktop, and Android observations?

## 12. First technical build sequence

1. Build the extension shell and ChatGPT adapter.
2. Capture visible messages, URLs, IDs/hashes, and timestamps.
3. Send events to a local test endpoint or development Worker.
4. Store them in Supabase and R2.
5. Display them in a minimal Diagnostics page.
6. Add cursoring, deduplication, reload recovery, and performance measurement.
7. Add scheduled checkpoint summarization using the test provider/model setting.
8. Add the first search and MCP retrieval path.
9. Add Claude and Gemini adapters.

This sequence validates the riskiest assumption—the browser capture pipeline—before the rest of the product is built around it.

The next blocking sequence is Gate 4B cross-platform capture:

1. Freeze Capture API v2 origin and coverage metadata.
2. Add Firefox while retaining one shared WebExtensions adapter core.
3. Prove structured Codex and Claude Code capture.
4. Find and prove the most structured Antigravity capture source.
5. Prove macOS Accessibility capture, then port the companion adapter boundary to Windows UI Automation.
6. Prove allow-listed Android Accessibility capture and Share Sheet fallback.
7. Add provider export importers and opened-chat backfill.
8. Reconcile the same conversation across devices and adapters.
9. Run every captured source through the existing summary, memory, retrieval, export, and deletion lifecycle.
