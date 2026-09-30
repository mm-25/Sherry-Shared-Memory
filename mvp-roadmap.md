# MVP Roadmap — Shared AI Memory Platform

Status: working roadmap v0.1

This roadmap is designed to reduce repeated decision-making. Product decisions are grouped into gates. We should complete a gate before starting the next one, but engineering experiments can answer technical uncertainties without requiring a product decision first.

## What the MVP is

The first MVP will be a private cloud memory platform with:

- a responsive web/PWA application for memory, sources, projects, settings, export, deletion, and diagnostics
- Chromium and Firefox extensions for visible browser-conversation capture
- ChatGPT, Claude, and Gemini web adapters
- a macOS and Windows Memory Capture Companion for supported native desktop applications
- structured hook/session capture for Codex, Claude Code, and Antigravity where available
- an Android proof-of-concept app with opt-in accessibility capture for ChatGPT, Claude, and Gemini
- official provider-export import and automatic backfill when an older web conversation is opened
- Cloudflare R2 for raw content and Supabase for metadata, search, permissions, and audit records
- persistent checkpoint summaries and explicit user notes (automatic memory claims were retired)
- a retrieval service exposed through MCP
- cross-provider retrieval enabled by default, with provider-level controls
- visible source-chat links where providers support them

The MVP will not replace native AI interfaces or attempt to read hidden provider-native memories, system prompts, or private reasoning. It will capture user-visible conversations through the best available adapter for each supported surface. Full target coverage and acceptance criteria are defined in [the cross-platform capture specification](cross-platform-capture.md).

## Capture-client responsibility

Browser extensions, desktop companions, coding-agent hooks, Android accessibility, share actions, and importers are sensors and uploaders—not the memory database. They normalize authorized conversation events; the cloud remains responsible for canonical identity, deduplication, storage, summarization, retrieval, permissions, and diagnostics.

### The extension can

- recognize supported provider pages using URL patterns and site adapters
- observe newly rendered user and assistant messages
- read visible titles, timestamps, URLs, links, and permitted attachment metadata
- maintain a lightweight local cursor and content hashes
- upload small batches asynchronously
- pause, resume, or switch to manual capture

### The extension cannot reliably

- read hidden provider memory, system prompts, or private model reasoning
- see content that the provider never renders in the page
- guarantee stable message IDs when a provider does not expose them
- detect edits or deletions that happened before capture began
- understand every future platform from a URL alone
- decide whether something should become a durable memory
- perform summarization or database search efficiently in the browser

The server remains responsible for canonical conversation identity, deduplication, cursors, storage, summarization, retrieval, permissions, and diagnostics.

## Decision gates

### Gate 0 — Product foundation

Status: mostly complete

- [x] Define the product as a cloud memory layer rather than a replacement chat client.
- [x] Define individual users and a private workspace as the initial audience.
- [x] Select Supabase and Cloudflare R2 as the initial managed backend.
- [x] Decide that Google Drive is an export/import option, not the live retrieval database.
- [x] Decide that ChatGPT, Claude, and Gemini are the first supported platforms.
- [x] Add Settings and Diagnostics as first-class product surfaces.

Exit condition: the product boundary is understandable in one paragraph.

### Gate 1 — Memory policy

Status: complete for MVP direction

- [x] Define raw conversation, checkpoint summary, memory claim, note, and source in plain language.
- [x] Decide whether checkpoint summaries are created automatically; they run on a user-controlled fixed schedule, defaulting to 10 minutes.
- [x] Decide whether atomic durable memory claims require confirmation; claims are created automatically as provisional items and reviewed later with yes/no/not sure.
- [x] Define which sensitivity categories users can toggle; Financial, Health, and Personal are enabled by default. Turning one off keeps its information stored in Sherry but prevents connected AI tools from retrieving that category. Until chats can be reliably classified, any off switch also withholds unlabelled chats, summaries, notes, and project listings from connected AI tools. The switches are released; signed-in live behavior verification remains in Gate 9.
- [x] Confirm the default treatment of credentials and financial information; credentials and payment/account secrets remain blocked from long-term storage.
- [x] Confirm that a newly connected provider receives existing shared memories by default, with provider controls available.
- [x] Define exactly what “delete transcript,” “delete summary,” and “delete both” do.
- [x] Define how edited summaries affect related memory claims; related claims are shown for separate review.

Exit condition: we can explain what is collected, what persists, what is shared, and what deletion means without using engineering language.

### Gate 2 — Technical architecture and privacy model

Status: complete for MVP direction; implementation validation continues in later gates

Coverage: [Technical architecture](architecture.md) contains the reviewed end-to-end flow, component responsibilities, storage split, authentication approach, privacy boundaries, intermediate retrieval layer, reliability behavior, and cost controls. Each later implementation gate validates the relevant part of this architecture.

- [x] Draw the end-to-end flow from browser page to extension to cloud service to AI-tool retrieval.
- [x] Define authentication for the platform account and provider connections.
- [x] Define where OAuth tokens and test API keys are stored and how they are revoked.
- [x] Define tenant isolation, permissions, encryption, audit logging, and export/delete behavior.
- [x] Define the intermediate retrieval layer so normal searches do not call Google Drive.
- [x] Define initial cost controls for R2, Supabase, browser traffic, and summarization.

Exit condition: we know where every type of data lives, who can access it, and how it moves.

### Gate 3 — Data model and service contracts

Status: complete for MVP direction; contracts are versioned as each service is implemented

Coverage: [Data model](memory-data-model.md) and [Retrieval/MCP protocol](retrieval-mcp-protocol.md) define the main entities, cursors, evidence, summaries, conflicts, retrieval actions, and context packet. Exact network payloads are versioned when each implementation gate begins; Capture API v1 is now frozen in [the ingestion contract](ingestion-api.md).

- [x] Finalize users, private workspaces, projects, provider connections, sources, conversations, and events.
- [x] Finalize message IDs, hashes, sequence numbers, sync cursors, and checkpoint cursors.
- [x] Finalize attachments, web-search links, chat URLs, and message anchors.
- [x] Finalize checkpoints, memory claims, evidence links, conflicts, and version history.
- [x] Finalize summarization jobs, retrieval requests, diagnostics, and audit events.
- [x] Define the first-version API families for capture, search, source inspection, export, deletion, and diagnostics; freeze each exact wire contract when its gate is implemented.

Exit condition: a developer can build the database and APIs without inventing missing relationships.

### Gate 4 — Browser-capture proof of concept

Status: complete for the ChatGPT-on-Brave proof of concept

- [x] Build the extension shell with permissions limited to supported sites.
- [x] Build a ChatGPT adapter to prove the capture pattern.
- [x] Implement conversation URL, title, visible-message, author, order, link, and capture-time extraction.
- [x] Implement debounced observation of changed message nodes instead of continuous full-page scans.
- [x] Generate provider IDs where available and hashes/sequence identities where they are not.
- [x] Handle page navigation, reloads, long conversations, and missed-event backfill.
- [x] Add pause/resume and manual-capture controls.
- [x] Measure practical page responsiveness and duplicate behavior during the controlled Brave run; detailed extension-only CPU/memory and network attribution moves to Gate 9.

Current evidence: twelve core tests pass, all extension scripts pass syntax checks, and the manifest parses successfully. The controlled Brave run produced 36 new expected transcript events across four normal chats: 12 streaming/interruption/reload events, 6 backfill events, 2 normal-after-temporary events, and 16 long-chat events. Together with the six-event baseline, Diagnostics stored exactly 42 canonical events. Streaming updated existing records four times without creating extra final records; 41 repeat observations were ignored; all backfill markers were recovered; all eight long-chat prompts and responses were present; no `Thinking` or provisional-ID records remained; all four temporary-chat messages were excluded; and no diagnostic errors occurred. Scan wall time averaged 47.6 ms over 57 samples. The user reported no noticeable speed, typing, scrolling, or responsiveness problem during the real test, which satisfies this proof-of-concept exit condition. More isolated CPU, memory, and network attribution remains a Gate 9 hardening task rather than a Gate 4 blocker.

Exit condition: a long active conversation can be captured without noticeable typing or scrolling lag, and reloads do not create duplicate events.

### Gate 4B — Cross-platform capture proof of concept

Status: in progress; Capture API v2 and Chromium provider-adapter foundation complete; blocks Gate 8 completion

Coverage: [Cross-platform capture specification](cross-platform-capture.md) defines the target surfaces, adapter hierarchy, normalized event contract, required scenarios, privacy controls, proof sequence, and acceptance criteria.

- [x] Extend the capture contract and data model for product, surface, adapter, device, app version, local source locator, and coverage/gap state. Capture API v2 is deployed with a backward-compatible v1 path, RLS-protected device/adapter records, and structured provenance across batches, conversations, events, and cursors.
- [x] Port the WebExtension to Firefox and validate ChatGPT, Claude, and Gemini capture. The shared MV3 package was loaded in Zen/Firefox and delivered committed Capture API v2 batches for all three providers; a fresh two-turn Claude test arrived in exact user/assistant order without gaps or duplicates.
- [ ] Obtain Mozilla's signature for the submitted unlisted Firefox package and install the returned `.xpi` permanently in Zen. Version 0.3.1 was submitted successfully and is pending Mozilla human review; its 31 extension tests, syntax checks, automated validation, upload archive, and privacy disclosure are complete.
- [ ] Validate all three provider adapters in Chromium/Brave using the same normalized contract.
- [ ] Implement Codex capture through hooks or structured session events; use MCP for retrieval and explicit writes.
- [ ] Implement Claude Code capture through hooks or structured session events; use MCP for retrieval and explicit writes.
- [ ] Determine and implement the most structured available Antigravity capture path; retain accessibility and explicit MCP writes as fallbacks.
- [ ] Build a macOS Memory Capture Companion and test ChatGPT and Claude desktop capture.
- [ ] Build a Windows companion using the same adapter interface and Windows UI Automation.
- [ ] Build an Android proof-of-concept Accessibility Service for ChatGPT, Claude, and Gemini, with package allow-listing, pause, diagnostics, and encrypted offline queue.
- [ ] Add Android Share Sheet capture as a manual fallback.
- [ ] Add official ChatGPT, Claude, and Gemini/Google Takeout export importers with preview, progress, deduplication, error reporting, and import-batch undo.
- [ ] Add opened-chat historical backfill for browser conversations.
- [ ] Test streaming, long chats, scrolling, branches/retries, app switching, restarts, offline recovery, permission revocation, and provider UI updates.
- [ ] Test cross-device and cross-adapter deduplication for the same synchronized conversation.
- [ ] Show complete, partial, gap-detected, unsupported, and fallback-only capture states in Diagnostics.

Exit condition: every required web, macOS, Windows, coding-agent, Antigravity, and Android surface has a demonstrated capture path; both sides of real conversations reach the cloud without silent loss or duplication; incomplete coverage is visible; and the captured data survives the complete memory lifecycle.

Current browser evidence: extension version 0.3.1 includes ChatGPT, Claude, and Gemini site adapters on one Capture API v2 path. ChatGPT remains validated from Gate 4. Claude was live-validated in Brave against an eight-turn conversation: the local store and Supabase both contain exactly eight ordered user/assistant events. That run exposed and fixed two silent-loss risks—a concurrent local/upload-queue write race and unstable provider-page DOM identifiers. Capture mutations are now serialized, impossible historical sequence values are repaired before upload, and unambiguous legacy identities migrate to deterministic sequence/role identities locally and in Supabase. The package declares Chromium and Firefox MV3 backgrounds together and uses browser-neutral Promise/callback API wrappers. It reloads successfully in Brave and installs temporarily in Zen/Firefox with stable extension ID `shared-memory-capture@memory.local`. A Firefox-only user-gesture error in optional permission requests was fixed by moving both host-permission requests directly into the Connect handler. Zen then delivered committed v2 batches for ChatGPT (six events), Claude (five existing events plus a fresh two-event verification), and Gemini (six alternating user/assistant events). The fresh `Firefox capture verification` conversation is sequence 0–1, user then assistant, with two distinct event keys, complete observed-range coverage, no gap, and no duplicate or update count. Firefox is therefore live-validated across all three providers. For permanent distribution, version 0.3.1 declares Firefox's required data categories, limits optional network permissions to Memory's Supabase and Worker origins, withholds optional technical identifiers when consent is absent, and supports per-profile Firefox extension origins without treating CORS as authorization. Mozilla validation reports zero errors; the remaining action is AMO unlisted signing and permanent `.xpi` installation. Gemini still needs a Brave/Chromium proof before the separate Chromium checklist item is checked.

### Gate 5 — Ingestion and storage pipeline

Status: complete

- [x] Authenticate extension requests through Supabase user sessions; keep the database secret in the Worker only.
- [x] Receive and validate versioned event batches with provider URL, size, and count limits.
- [x] Redact excluded credentials before long-term storage and retain only audit-safe category counts.
- [x] Store raw payloads in R2 and searchable metadata in Supabase.
- [x] Deduplicate by provider ID, hash, conversation, and sequence.
- [x] Advance cursors only after safe storage.
- [x] Create text chunks and full-text indexes.
- [x] Add retries, idempotency, backfill, and deletion jobs. Deletion rewrites shared R2 archives and records a tombstone to prevent re-import.

Current implementation: [`ingestion-api.md`](ingestion-api.md) freezes Capture API v1. [`backend/`](backend/README.md) contains the deployed Cloudflare Worker and Supabase migrations, deterministic R2 object keys, immutable-retry protection, searchable event chunks, RLS-protected user reads, and tested deletion/export flows. The repaired cloud dataset contains all 42 captured events across five conversations, including all 16 events in Memory Test 4. Conversation viewing and whole-workspace JSON export were verified in Brave and the in-app browser.

Exit condition: captured events reliably appear in the web app and can be deleted or exported.

### Gate 6 — Summarization and memory pipeline

Status: complete

- [x] Define time-based checkpoint eligibility: automatic summaries wait until the latest captured chat update has been quiet for the chosen interval; manual runs may start immediately.
- [x] Select only new or revised events after the previous checkpoint, with a two-event continuity overlap and previous-summary context.
- [x] Build a summarizer gateway with provider/model selection for Anthropic, OpenAI, Google Gemini, and xAI Grok.
- [x] Expose provider, model, schedule, and encrypted API-key controls in test Settings.
- [x] Track provider-reported tokens, exact provider cost where available, failures, attempts, and model version. Pricing-based estimates and provider-credit balances remain a later cost-validation task because providers do not expose one common credit-balance contract.
- [x] Store persistent summaries with exact source event IDs and revisions.
- [x] Allow users to view evidence and version history, edit summaries as new versions, or delete generated summary text independently from the transcript.
- [x] Create provisional memory-claim suggestions and a Yes/No/Not sure confirmation UI.
- [x] Preserve evidence, review history, and conflict history when claims change.

Exit condition: a captured conversation produces an understandable, editable summary without reprocessing the entire conversation each time.

Current implementation: [`summarization-pipeline.md`](summarization-pipeline.md) documents the checkpoint contract. The live pipeline schedules incremental summaries, preserves exact source lineage, supports Anthropic/OpenAI/Gemini/Grok, and provides editable summaries, retries, and encrypted test credentials. Automatic claim and conflict generation, and their review UI, were subsequently retired. The controlled quality test produced a useful compact summary of the user's platform work and current preferences. Further quality tuning now belongs to Gate 10 and normal usage evidence.

The checked claim/conflict tasks above record historical work, not currently enabled features. Any future cross-chat contradiction handling needs a separate product decision and semantic validation; it should not be restored merely because summary wording differs.

### Gate 7 — Basic retrieval and provider connection

Status: complete

- [x] Implement authentication and scope checks.
- [x] Implement exact/full-text search first.
- [x] Retrieve confirmed claims, persistent summaries, relevant source excerpts, and conflicts.
- [x] Prefer exact source excerpts and atomic claims over summaries when the query asks for specific facts, preferences, corrections, names, dates, or lists.
- [x] Return source URLs, message ranges, timestamps, authority, and status.
- [x] Enforce provider-level retrieval permissions.
- [x] Implement read tools and explicit note-saving tools.
- [x] Add context-size limits, deduplication, stale-index indicators, and audit records.
- [x] Connect one external AI provider and validate the complete authorization, tool-discovery, retrieval, and answer flow. Claude is the first validated provider.

Exit condition: an AI tool can explicitly request stored memory, receive a small traceable context packet, and use it without receiving unauthorized data. Sophisticated ranking and automatic retrieval behavior are intentionally deferred to Gate 10.

Current implementation: the live Worker exposes an OAuth-protected MCP endpoint at `https://shared-memory-ingestion.mufaddal-m25.workers.dev/mcp`. It offers search, compact context, source inspection, project listing, permission inspection, and explicit note saving. Settings includes separate read/write controls for ChatGPT, Claude, Gemini, and Grok plus a retrieval simulator. Search uses excerpts, notes, and summaries, not historical claims or conflicts; packets are bounded and deduplicated, include provenance and index health, and audit only a hash of the query. Claude successfully completed OAuth, discovered the Shared Memory tools, retrieved stored context, and used it in an answer. This satisfies the Gate 7 exit condition; other-provider compatibility checks continue under Gate 9.

### Gate 8 — Cross-platform product and UX/UI

Status: the first web-product phase was closed by the user on September 29, 2026. Gate 8A information architecture and Gate 8B state-inventory review have resumed in parallel with the focused Gate 9 safety pass; this does **not** claim that the original cross-platform Gate 8 exit condition has been met. Hold 8C product expansion until Gate 9 is finished, then 8D until 8C. Accessibility verification is set aside for now. Unchecked work remains open or explicitly deferred; some items were split because only their web portion is complete.

The Sherry web app now has a signed-in, live-data product shell based on the user's annotated wireframes and a Linear-informed visual system. Dashboard drilldowns, Chat Memory search/filters and source details, durable user-authored Personal Memory, Connected Conversations, Settings, and in-app Diagnostics are implemented. The local design preview and signed-in product audits are recorded in [`design-qa.md`](design-qa.md), [`audits/2026-09-24-platform-review/audit-report.md`](audits/2026-09-24-platform-review/audit-report.md), and [`audits/2026-09-25/report.md`](audits/2026-09-25/report.md). These audits identify remaining accessibility, completeness, and graph-legibility risks rather than certifying them resolved. Automatic memory claims and conflict review were retired from the active product; the hidden legacy review view is not counted as an active Gate 8 feature.

#### 8A — Experience definition

- [x] Inventory the existing console and map the principal web actions and flows in [`gate-8-ux-plan.md`](gate-8-ux-plan.md); audit the signed-in product afterward.
- [x] Establish the current web navigation and terminology: Dashboard, Chat Memory, Personal Memory, Connected Conversations, Settings, and Diagnostics.
- [x] Translate the user's annotated wireframes into the current web flows for daily browsing, conversation/summary inspection, personal-memory editing, retrieval testing, and data export.
- [x] Set a current-web information hierarchy with concise cards, detail dialogs, source evidence, and technical diagnostics behind deliberate entry points.
- [ ] Finalize the wider information architecture and complete task/state maps for onboarding, projects, dedicated Sources/Timeline, provider connection/disconnect, retrieval inspection, and full account deletion. Reconcile terminology with the retirement of claim/conflict review.
- [x] Prepare a reviewable [interactive current/proposed sitemap and user-flow map](planning/gate-8-ia-review/index.html), with a companion [Gate 8A decision brief and Gate 8B state inventory](gate-8-ia-review.md). This is a draft for user decisions, not final IA approval or implementation.

#### 8B — Visual and interaction system

- [x] Create a Memory design foundation covering color, typography, spacing, density, iconography, borders, elevation, motion, responsive behavior, and accessibility for the current web surfaces.
- [x] Use the Linear reference for reusable UI patterns such as the app shell, navigation, lists/tables, filters, search, detail panels, dialogs, forms, badges, and status communication.
- [x] Build a reusable frontend component system instead of styling each screen independently. The current plain application uses shared semantic classes and tokens; framework extraction is not required for this pass.
- [x] Implement current-web loading, empty, warning/error, disconnected-extension, and destructive-confirmation patterns where those flows exist.
- [x] Implement responsive web layouts, visible focus styles, and reduced-motion CSS for the current interface.
- [ ] Complete and verify the full state inventory—including stale/partial capture, permission denial, slow operations, and source unavailability—on every relevant surface. Conflict-review states are out of scope while that feature is retired.
- [x] Document the current/proposed 26-state inventory with coverage labels and design questions in the [interactive review map](planning/gate-8-ia-review/index.html). User review, design resolution, implementation, and end-to-end verification remain open above.
- [ ] Audit keyboard navigation, focus management, measured contrast, screen-reader labels, zoom, reduced motion, and desktop/mobile behavior across the whole product; existing CSS and the first-pass mobile review are not an accessibility sign-off.

#### 8C — Product implementation

- [x] Build sign-in and sign-out for an existing Sherry account.
- [ ] Add in-app account creation and user-managed private workspace/project creation.
- [x] Add per-provider retrieval permissions and connection information in Settings; put installed browser-extension capture controls in Diagnostics.
- [ ] Complete provider connection onboarding, account-aware connection management, and disconnect flows. The “Add provider” dialog currently lists planned providers rather than connecting them.
- [x] Build the Chat Memory source list/detail, transcript and summary views, source evidence, Personal Memory category/entry editing, and Connected Conversations graph.
- [ ] Build dedicated Sources and Timeline views; Chat Memory and Diagnostics cover only parts of those concepts today.
- [x] Build current Settings for summarization, AI retrieval permissions/testing, historical chat import, conversation export, and account data; provide browser capture/attachment/temporary-chat controls in the in-app Diagnostics view.
- [ ] Add storage/retention controls, a complete workspace export covering Personal Memory and notes, and a working whole-workspace deletion flow. Financial, Health, and Personal AI-retrieval switches are live, subject to Gate 9 end-to-end verification. The current “Export Sherry workspace” download contains conversations, while “Delete workspace data” is informational only.
- [x] Build the in-app Diagnostics surface for cloud stages, failures, extension status, capture controls, and recent extension events.
- [x] Build individual conversation, summary, and Personal Memory deletion actions, plus single-chat and all-conversations JSON export.
- [ ] Complete and verify full workspace deletion, propagation/recovery, and provider disconnect. See the focused Gate 9 deletion-safety work before treating these as released.
- [x] Make the current web interface responsive for desktop and narrow/mobile widths.
- [ ] Make the web product installable as a PWA for desktop and Android.
- [ ] Build macOS and Windows companion control surfaces for permissions, per-app capture, pause, queue status, gaps, and diagnostics.
- [ ] Build the Android control surface for account access, package selection, capture status, pause, Share Sheet, queue state, and diagnostics.
- [x] Show aggregate cloud pipeline, provider mix, extension sync, pending-upload, and recent-capture status in the current web app.
- [ ] Show verified capture coverage and gaps broken down by provider, product, surface, device, and adapter.
- [x] Apply the current design tokens and interaction patterns across the implemented web surfaces.
- [ ] Apply and validate the same system on future PWA, desktop, and Android companion surfaces.

#### 8D — Experience validation

- [x] Review the implemented local flows against the approved wireframes before visual polish.
- [x] Run first-pass local design QA with realistic preview content and a narrow/mobile viewport, then audit principal signed-in web flows with live data.
- [x] Review visual consistency and interaction quality across the implemented web shell; record the remaining findings rather than treating the audit as a pass on every detail.
- [ ] Systematically test long content, first-use empty states, partial capture, failures, slow operations, and recovery in the signed-in app.
- [ ] Complete responsive and accessibility verification, including keyboard/focus, contrast, reduced motion, graph usability, and clear destructive-action confirmations across all intended surfaces.

Original exit condition: a user can understand and control what was captured, summarized, shared, and deleted through a coherent, accessible, responsive interface reviewed against the agreed wireframes and design system. The current web slice substantially supports this, but the unchecked cross-platform, accessibility, and lifecycle work above has not been verified against the full original condition.

### Gate 9 — Security, quality, and launch readiness

Status: focused safety pass in progress, **not yet passed**. Broader pilot and launch checks follow Gate 10.

Gate 9 asks whether Sherry can be trusted with a user's memory: can only the right person and connected AI read it, are sensitive details handled as promised, does deletion actually remove it, and can capture/import deliver it reliably? The **focused pass** answers those four questions before we tune retrieval in Gate 10. It does not certify the whole MVP for launch. The remaining cross-platform, performance, documentation, and pilot checks stay in Gate 9 for after Gate 10. Detailed evidence is in [`gate-9-safety-pass.md`](gate-9-safety-pass.md).

#### Focused safety pass — before Gate 10

| Safety question | Achieved so far | Required to pass |
| --- | --- | --- |
| **Account isolation:** Can another Sherry user or a disabled AI connection read or change this workspace? | Local tests reject another workspace's conversation read/delete and unauthorized ingestion; a read-only live search using a different user ID returned zero results. A live read-only transaction as an unrelated authenticated user saw zero workspaces, conversations, events, claims, and tombstones. The deployed MCP fix requires the current provider read permission for source inspection/project listing and a write-capable OAuth token for note saving. A further live Worker fix prevents Settings, the retrieval test, and OAuth reconnect from silently turning disabled provider access back on; 108 backend tests pass and a signed-out permission read returned 401. | Test two real accounts and a disabled/read-only connection against the live Worker and MCP endpoint. This is Sherry workspace isolation; separate accounts *within one AI provider* are a later milestone. |
| **Sensitive-data handling:** Do secrets stay out of long-term storage, and do category choices work? | Redaction occurs before R2/database writes. Local tests cover credentials, cards, URL query secrets, URL passwords, fragment tokens, attachment metadata, and source locators. The metadata fixes are deployed. Live metadata records three redactions in one batch without exposing their values. Workspace Financial, Health, and Personal switches and the database migration are live. Personal Memory receives labels; when any category is off, connected AI tools receive allowed labelled entries but no unlabelled chats, summaries, notes, or project list. The settings table has RLS, and an unrelated database identity sees zero rows. | Test category changes through a signed-in live session and AI search/source lookup; run a controlled secret capture. Future chat classification may make the restrictive mode more useful. Pattern matching alone cannot prove every secret form is caught. |
| **Deletion propagation:** Does deleting a conversation remove every linked copy and stop recapture? | Local tests cover R2 archive rewriting, database cascades, tombstones, and retry after an R2 object was already removed. Live data has two deletion tombstones with no matching conversation and no orphaned events. R2's 440 object keys match the 440 ingestion-batch keys, though archive contents were not inspected. The approved migration deleted nine source-less historical claims; zero match the cleanup rule now, and the live trigger removes claims linked to future deleted conversations. | Perform a controlled live deletion and check R2 archive content, Supabase events/chunks/summaries/claims, search and MCP lookup, and recapture prevention. |
| **Capture/import integrity:** Does every expected message arrive once? | A September 29 live ChatGPT batch received and inserted 11 events. Read-only live checks found 440 committed batches with balanced counts, no duplicate canonical event or provider-message IDs, and no recorded gap flags. Local extension/database tests cover retries, revisions, backfill, and deduplication; Claude import previews overlap and uncertain matches. The live importer rejects uncommitted, partial, and tombstoned receipts, repeated source identities, and missing IDs/roles on cloud readback, including chats over 1,000 messages. The readback endpoint rejects signed-out requests. Backend 113 and web 19 tests pass; the deployed app script matches the local file checksum. | Exercise import readback with real exports, compare source-visible identities and counts to local extension state and cloud events for ChatGPT, Claude, and Gemini after reload, navigation, offline recovery, and import retry, and report source records omitted by each format. Zero gap flags or duplicates in stored rows cannot prove that nothing was missed at the source. |

The focused pass is complete only when all four rows have live evidence and any identified data remnants are addressed. The current result is **partial verification**, not a safety sign-off: the nine approved historical claims have been removed, the category switches and import readback are live, and controlled end-to-end scenarios remain outstanding.

Next steps for this pass:

1. Run controlled live isolation, redaction, and deletion checks without using private conversation content as test material.
2. Reconcile representative browser captures and provider exports against what Sherry stored; make incomplete imports and uncertain overlaps visible.
3. Verify the promised sensitivity-category switches with signed-in live AI search and source lookup. Keep the Settings explanation of the temporary unlabelled-chat restriction visible.
4. Record pass/fail evidence for each row above. Then begin Gate 10 retrieval evaluation.

#### Broader Gate 9 pilot checks — after Gate 10

- [ ] Test extension performance on all three supported platforms.
- [ ] Test the Firefox extension separately from Chromium extension behavior.
- [ ] Test the complete capture matrix on macOS, Windows, and Android.
- [ ] Test OS permission grant, denial, revocation, and recovery for desktop and Android capture.
- [ ] Test that accessibility adapters cannot collect from applications outside the explicit allow-list.
- [ ] Test structured hooks, local queues, app restarts, OS restarts, offline recovery, and app-version changes.
- [ ] Test multi-device and cross-adapter deduplication for cloud-synchronized conversations.
- [ ] Test malformed official archives, partial failures, and import-batch undo across all supported importers after the focused completeness check.
- [ ] Test source links, expired URLs, and provider login requirements.
- [ ] Validate the deployed MCP contract with ChatGPT, Gemini, and Grok after the successful Claude baseline.
- [ ] Test summarization cost under realistic usage.
- [ ] Create privacy notice, consent language, data export, and account deletion documentation.
- [ ] Run a small private pilot before public release.

Exit condition: the MVP is reliable, explainable, reversible, and safe for a small group of test users.

### Gate 10 — Memory retrieval intelligence and ranking

Status: next after the focused Gate 9 safety checks, ahead of broader Gate 9 pilot hardening

- [ ] Write the detailed retrieval specification covering query interpretation, candidate selection, ranking, context packaging, and provider delivery.
- [ ] Separate profile, project, episodic, source/document, instruction, and conflict memory types during retrieval.
- [ ] Add hybrid candidate retrieval using keyword, semantic, metadata, entity, and temporal signals where each improves measured accuracy.
- [ ] Discuss and prototype TypeSafe as a semantic judgment layer alongside retrieval—not as a replacement for keyword, semantic, or metadata search. Evaluate its use for query interpretation, relevance scoring, memory-claim verification, scope/sensitivity classification, conflict detection, and confidence-aware escalation.
- [ ] Define the boundary between ordinary application rules, retrieval, general-purpose summarization, and TypeSafe judgments. Keep permissions, redaction, storage, deletion, and final user confirmation deterministic and under product control.
- [ ] Evaluate candidate semantic workflows against measured retrieval errors before choosing one; do not restart automatic claim extraction or conflict review without a separate product decision and evidence it helps users.
- [ ] Measure TypeSafe against representative cases before expanding its role, including durable preferences, temporary instructions, project-specific facts, corrections, conflicting claims, sensitive content, and no-match cases.
- [ ] Index conversation metadata—including titles, provider, timestamps, source type, and project—and route metadata questions to those fields instead of searching message bodies indiscriminately.
- [ ] Analyze patterns across multiple conversations or sources, such as repeated chat-title conventions, while distinguishing an observed pattern from an explicitly stated user preference.
- [ ] Return grouped evidence, counts, examples, exceptions, and time range for cross-conversation conclusions so the AI can explain how the pattern was inferred.
- [ ] Build ranking that considers relevance, active scope, confirmation status, recency, importance, source reliability, validity, and conflicts.
- [ ] Define how confirmed, provisional, stale, superseded, and contradictory memories appear in the context packet.
- [ ] Add user-controlled retrieval context budgets in Settings: maximum text characters, maximum attachments per retrieval request, and maximum size per attachment. Enforce provider/platform hard limits, report when content was truncated, and keep these delivery limits separate from capture and storage limits.
- [ ] Implement a hybrid delivery strategy: a small automatic context packet where the provider surface permits it, plus MCP tools for deeper on-demand searches.
- [ ] Tune provider adapters for the different retrieval and tool-use behavior of ChatGPT, Claude, and Gemini without changing the shared memory contract.
- [ ] Show users which memories were retrieved, why they were selected, where they came from, and whether the provider used them.
- [ ] Create a representative retrieval test set with known correct answers, including exact facts, preferences, project decisions, dates, entities, conflicts, and missing-memory cases.
- [ ] Measure retrieval precision, missed relevant memories, unsupported claims, latency, context size, provider tool-call rate, and cost; tune against those results.

Exit condition: across ChatGPT, Claude, and Gemini, representative questions consistently receive the most relevant authorized memories with traceable sources, bounded context, visible uncertainty, and acceptable latency and cost. Any TypeSafe integration is evaluated as a measurable semantic decision layer around retrieval and memory review, with clear evidence that it improves quality without weakening permissions, provenance, or user control.

### Future milestone — multiple accounts per AI provider

Status: planned for later; not part of the current single-account workflow. Design the provenance model before connecting or importing a second account from the same provider.

- [ ] Give each connected source account its own stable identity, separate from provider, workspace, conversation, and AI-agent identity. Preserve an explicit “unknown account” state for older captures that cannot be attributed reliably.
- [ ] Carry source-account provenance through browser capture and imports; include it in conversation matching and deduplication so overlapping exports and live capture merge only within the correct account.
- [ ] Let users browse and filter chats, summaries, and memories by provider account and, where reliably available, by agent. Keep an “all accounts” view.
- [ ] Enforce account and agent access scopes in retrieval on the server, and show which account supplied each retrieved memory. Decide whether notes saved directly to Sherry are global or account-scoped before exposing account-specific note controls.

### After Gate 10 — user-owned memory directions to discuss

These are MVP roadmap discussion topics, not implemented features or settled requirements. Revisit them after retrieval quality is measurable:

1. **How does AI represent you, and how can Sherry shape that?** Let people inspect what a connected AI was given, what it inferred, and where its portrayal diverged from their own view; explore correction and provider-specific boundaries without claiming control over a provider's private behavior.
2. **How can users reclaim their own memory?** Explore understandable export, portability, correction, deletion, provenance, and the ability to choose which parts of their history each AI may use. Define what can actually be retrieved or removed from Sherry versus what remains on provider platforms.

## Questions we still need to answer

These are the remaining product questions. They are deliberately grouped so you do not have to answer dozens of small engineering questions at once.

### Product decisions for you

1. Which additional sensitivity categories should appear in Settings beyond financial, health, and general personal information?

### Questions we can answer through prototypes

1. Which provider exposes stable conversation and message identifiers?
2. Which provider URLs support direct links to a message or only to a conversation?
3. How reliably can each site adapter detect new messages and temporary chats?
4. How much CPU, memory, and network usage does the extension create?
5. How much does a typical checkpoint summary cost with each summarizer model?
6. What happens when the user is offline, closes the tab, reloads the page, or opens several conversations?

## Recommended order from here

1. Complete the focused Gate 9 safety pass: account isolation, sensitive-data handling, deletion propagation, and capture/import integrity.
2. Evaluate and improve retrieval relevance under Gate 10 with representative questions and measurable outcomes.
3. Complete the remaining Gate 9 cross-platform, performance, documentation, and private-pilot checks.
