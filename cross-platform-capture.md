# Cross-Platform Capture Specification — MVP

Status: approved MVP scope; Capture API v2 and provenance data model deployed; provider proofs in progress

## 1. Product requirement

Shared Memory must collect authorized conversation data wherever the user works, not only in a browser. Retrieval through MCP is necessary but is not a substitute for capture: an MCP server receives a conversation only when the host deliberately calls a write tool. The MVP therefore uses multiple capture adapters that all send the same normalized conversation events to the existing cloud ingestion pipeline.

The target loop is:

```text
capture on every supported surface
        ↓
normalize into one event contract
        ↓
deduplicate, store, index, summarize, and create memory
        ↓
retrieve through MCP on every compatible surface
```

“Comprehensive capture” means that, for every supported surface, the approved adapter can collect both user and assistant messages, preserve conversation identity and order, recover after interruption, expose gaps, and avoid duplicates. It does not include hidden system prompts, private reasoning, or content the application never exposes to an approved local integration.

## 2. Required MVP surfaces

| Provider family | Surface | Primary capture method | Required fallback |
| --- | --- | --- | --- |
| OpenAI | ChatGPT web on Chrome/Brave/Chromium | Browser extension site adapter | Open-chat backfill and official export import |
| OpenAI | ChatGPT web on Firefox | Firefox WebExtension adapter | Open-chat backfill and official export import |
| OpenAI | ChatGPT Chat/Work desktop on macOS and Windows | Memory Capture Companion using OS accessibility APIs | User-initiated import/share; export import |
| OpenAI | Codex app/CLI/IDE on macOS and Windows | Codex hooks or structured local session events | Desktop accessibility for visible app content; explicit MCP save |
| OpenAI | ChatGPT/Codex mobile on Android | Android Accessibility Service for visible ChatGPT conversations; Codex host hooks for remote Codex work | Android Share Sheet and export import |
| Anthropic | Claude web on Chrome/Brave/Chromium | Browser extension site adapter | Open-chat backfill and official export import |
| Anthropic | Claude web on Firefox | Firefox WebExtension adapter | Open-chat backfill and official export import |
| Anthropic | Claude desktop on macOS and Windows | Memory Capture Companion using OS accessibility APIs | User-initiated import/share; export import |
| Anthropic | Claude Code on macOS and Windows | Hooks or structured local session/transcript events | Desktop accessibility for visible app content; explicit MCP save |
| Anthropic | Claude mobile on Android | Android Accessibility Service | Android Share Sheet and export import |
| Google | Gemini web on Chrome/Brave/Chromium | Browser extension site adapter | Open-chat backfill and Google Takeout import |
| Google | Gemini web on Firefox | Firefox WebExtension adapter | Open-chat backfill and Google Takeout import |
| Google | Antigravity on macOS and Windows | Antigravity plugin, hook, or structured session integration | Desktop accessibility for visible content; explicit MCP save |
| Google | Gemini mobile on Android | Android Accessibility Service | Android Share Sheet and Google Takeout import |

MCP remains enabled for retrieval and explicit writes in Codex, Claude, Claude Code, Antigravity, and any other compatible host. An MCP write is supplementary unless the host guarantees that it is emitted for every completed turn.

## 3. Capture clients

### Browser extension

One shared WebExtensions codebase should support Chromium and Firefox, with provider adapters for ChatGPT, Claude, and Gemini. It captures new visible turns automatically and backfills an older conversation whenever the user opens it. Browser-specific manifests, permissions, background execution, storage, and packaging remain separate where required.

### Memory Capture Companion for macOS and Windows

The companion is a small local application, not a replacement chat client. It provides:

- per-application capture toggles and an explicit pause control
- macOS Accessibility and Windows UI Automation adapters
- structured hook/session integrations for coding agents when available
- a local encrypted upload queue with bounded retention
- capture status, detected conversation, last event, gaps, retries, and permission health
- app/version identification so a broken adapter is visible after a provider update
- strict process allow-listing so unrelated applications are not read

Structured hooks or local session events take priority over accessibility capture. Accessibility capture takes priority over screenshot/OCR. OCR is outside the first proof unless a required application does not expose text through accessibility.

### Android proof-of-concept application

The Android app provides Memory management plus an opt-in Accessibility Service. For the proof of concept, store-distribution policy is not a blocker. The service must:

- observe only explicitly enabled package names for ChatGPT, Claude, and Gemini
- read accessible text, element roles, window changes, and scroll changes
- distinguish user and assistant turns where the UI exposes that distinction
- detect streaming updates and save the stable final revision
- maintain conversation-level cursors and content hashes
- queue encrypted events while offline and upload asynchronously
- show an always-visible capture state and immediate pause action
- support Android Share Sheet ingestion as a manual fallback

Notification text alone is insufficient because it is partial. Screenshot/OCR and automated scrolling are experimental fallbacks, not the default capture path.

### Historical importer

The web product accepts official account exports from ChatGPT, Claude, and Gemini/Google Takeout. It must preview conversation count, date range, attachments, unsupported records, and estimated storage before import. Imported data is deduplicated against live capture and grouped under an undoable import batch. “All history” means all eligible records present in the provider archive; deleted, temporary, expired, or administrator-restricted chats may be absent.

## 4. Normalized event contract

Implementation progress: the v2 envelope, device and adapter records, source locator, structured coverage state, and backward-compatible v1 path are deployed. Extension version 0.3.1 contains ChatGPT, Claude, and Gemini adapters on a shared provider runtime and one cross-browser MV3 package. ChatGPT and Claude have live Brave evidence; Claude captured and delivered all eight visible turns exactly once after identity reconciliation. Zen/Firefox has delivered committed v2 batches for ChatGPT, Claude, and Gemini, including a fresh two-turn Claude verification in exact order without gaps or duplicates. The unlisted Mozilla upload package now passes validation with zero errors and includes mandatory data disclosures; Mozilla signing and permanent `.xpi` installation remain. Gemini's Brave/Chromium pass, native clients, coding-agent adapters, Android, and importer adapters still require implementation and live proof.

Every adapter must produce the same logical fields even if some values are unavailable:

- workspace and user identity
- provider family: `openai`, `anthropic`, or `google`
- product: `chatgpt`, `codex`, `claude`, `claude_code`, `gemini`, or `antigravity`
- surface: `web`, `desktop`, `cli`, `ide`, or `android`
- capture adapter and adapter version
- device ID, operating system, application/package version, and capture session ID
- provider conversation ID when exposed; otherwise a stable locally derived conversation key
- provider message ID when exposed
- role, message text, sequence, timestamps, content hash, and revision
- title, source URL/deep link when available, and local source locator when no URL exists
- links and settings-permitted attachment metadata
- capture reason: live change, reload recovery, opened-chat backfill, hook, accessibility event, share action, or historical import
- coverage state: complete for observed range, partial, gap detected, or awaiting backfill

The server remains authoritative for canonical conversation identity. It may merge provisional identities produced by different devices or adapters after comparing provider IDs, account, title, time, sequence, and content hashes.

## 5. Required use cases

Each adapter must be tested against the use cases that apply to its surface:

1. Start a new conversation and capture alternating user and assistant turns.
2. Capture a streaming response as one message with revisions, not several messages.
3. Switch between conversations without mixing their events.
4. Close and reopen the application without duplicating existing events.
5. Recover messages created while the uploader was offline.
6. Open an older conversation and backfill its visible history.
7. Scroll a long conversation and reconcile previously unloaded messages.
8. Handle regenerated, retried, branched, or corrected responses without silently overwriting evidence.
9. Preserve titles, timestamps, links, code blocks, citations, and attachment metadata where exposed.
10. Respect capture-off, temporary-chat exclusion, attachment settings, and per-provider controls.
11. Pause immediately and cease observing disabled applications.
12. Detect permission revocation, application updates, inaccessible content, and capture gaps.
13. Deduplicate the same cloud-synchronized conversation observed on web, desktop, and Android.
14. Import an official provider archive without duplicating already captured conversations.
15. Retrieve captured memory through MCP in a different provider and preserve source attribution.

## 6. Privacy and user control

- Accessibility capture is opt-in per application and disabled for every unrelated process.
- The product visibly communicates when capture is active, paused, incomplete, or broken.
- Raw accessibility trees, screenshots, and unrelated window content are never uploaded as a general telemetry stream.
- Only normalized approved conversation fields enter the ingestion queue.
- Existing credential redaction runs before durable cloud storage.
- Users can inspect, export, and delete data by conversation, import batch, provider, device, or entire account.
- Disabling an adapter stops new capture but does not silently delete existing memory.
- Diagnostics records adapter health and errors without storing secrets or unrelated screen content.

## 7. Proof-of-concept sequence

1. Extend the ingestion contract and data model for product, surface, adapter, device, source locator, and coverage state.
2. Port the existing extension to Firefox and verify ChatGPT, Claude, and Gemini adapters.
3. Build Codex structured capture using hooks/session events and verify cross-device continuation.
4. Build Claude Code structured capture using hooks/session events.
5. Prototype Antigravity capture through a plugin, hook, or readable structured session source.
6. Build the macOS companion and test ChatGPT and Claude desktop accessibility trees.
7. Port the companion adapter layer to Windows UI Automation.
8. Build the Android Accessibility Service and test ChatGPT, Claude, and Gemini.
9. Add official export importers and opened-chat historical backfill.
10. Run multi-surface deduplication, restart, offline, gap, and permission tests.

## 8. MVP acceptance criteria

This capture gate passes only when:

- every required row in the surface matrix has a tested primary path or an explicitly approved fallback
- both user and assistant messages are captured for a real conversation on every automatic-capture surface
- conversation boundaries, order, revisions, restarts, and offline recovery work without silent loss
- the same conversation observed on multiple surfaces does not become duplicate memory
- incomplete capture is shown as incomplete rather than presented as a complete transcript
- capture can be paused and scoped per provider, application, and device
- source provenance identifies the originating provider, product, surface, and available link/locator
- captured events successfully flow through storage, summarization, review, retrieval, export, and deletion

If a closed native application exposes neither usable structured events nor accessible conversation text, that surface cannot be labelled full automatic capture. The product must show the fallback and coverage level plainly rather than claiming unsupported completeness.
