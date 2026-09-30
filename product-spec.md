# Product Specification — Sherry Shared AI Memory Platform

Status: working draft v0.1

Current MVP departure (September 2026): the Conflicts & Facts tab and its backend claim/conflict pipeline are retired. Summaries, source transcripts, and explicit notes remain active. Historical claim/conflict rows are retained only to avoid deleting user data without a separate decision; they are excluded from active retrieval. Claim-based flows below describe an earlier proposal, not current behavior.

## 1. Product concept

A singular Sherry platform that lets users keep a private, structured, searchable memory layer available across ChatGPT, Claude, Gemini, and connected sources. Users continue chatting in the native AI products; Sherry manages the shared memory, permissions, capture, search, and audit trail in one coherent product experience.

The MVP must work across browser, macOS, Windows, coding-agent, Antigravity, and Android surfaces. The user should not need to move every conversation into a Sherry-owned chat client. Capture is provided by surface-specific adapters that feed one shared cloud memory pipeline.

## 2. Primary user

An individual power user who works across multiple AI assistants and wants continuity without surrendering control of their data to any one provider.

The initial product uses a private individual workspace. The word “workspace” describes the user’s isolated data boundary, not a shared team space. Multi-user collaboration can follow the first release.

## 3. Main surfaces

- **Home:** recent activity, capture status, unresolved conflicts, and active projects.
- **Projects:** scoped memory spaces with sources, notes, conversations, and retrieval settings.
- **Memory:** confirmed, provisional, superseded, and conflicting claims with evidence and edit history.
- **Sources:** connected providers, Drive folders/files, uploaded documents, and captured conversations.
- **Timeline:** chronological source events, checkpoints, sync gaps, and processing status.
- **Connections:** provider authentication, permissions, enabled scopes, and pause/disconnect controls.
- **Policies:** capture, promotion, retrieval, sensitivity, and retention settings.
- **Settings:** profile, account security, notification preferences, default behavior, storage/export, and application preferences.
- **Diagnostics:** a testing area showing whether capture, sync, indexing, summarization, retrieval, and provider communication are working.
- **Audit:** access, imports, edits, exports, deletions, and conflict decisions.
- **Devices and Capture:** connected browsers, desktop companions, Android devices, app permissions, adapter health, capture coverage, queue state, gaps, and pause controls.

### UX/UI direction and design process

The current web console proves the underlying workflows but is not the intended MVP experience. Gate 8 includes redesigning and implementing the complete UX/UI, not merely applying visual polish to the existing pages.

The user will provide rough wireframes that establish product-specific intent, task flow, hierarchy, and expected controls. Those wireframes are the primary design input. Linear's UI patterns are the reference for a compact, precise product interface: restrained color, strong information hierarchy, consistent spacing, reusable controls, clear statuses, and purposeful motion. Sherry will adapt those qualities to its own content and trust requirements instead of reproducing Linear's branding or layouts literally.

The design sequence is:

1. Audit the present console and inventory all required user actions and system states.
2. Define the information architecture, navigation, terminology, and core user journeys.
3. Review and complete the user's rough wireframes, including missing states and edge cases.
4. Establish Sherry's visual tokens and reusable component library.
5. Implement the approved flows and components across every main surface.
6. Validate realistic content, responsive behavior, accessibility, motion, errors, and destructive actions before Gate 8 closes.

The interface should make provenance, memory status, provider scope, conflicts, and deletion consequences understandable at a glance. Technical diagnostics remain available through progressive disclosure rather than dominating everyday workflows.

## 4. Authentication and account linking

The platform account uses email magic link/passwordless login or Google sign-in. Provider and storage connections use separate OAuth flows. The platform never asks for a ChatGPT, Claude, Gemini, or Google password.

Each connection shows:

- account identity
- data it can read
- actions it can perform
- projects it can access
- last successful sync
- pause, revoke, and delete controls

Settings also includes a development/testing section where the project owner can select Anthropic, OpenAI, Google Gemini, or xAI Grok as the summarization provider, provide a compatible model name, and enter an API key. This is a testing control, not the intended production user experience. Keys are encrypted, masked, excluded from logs, and removable.

Settings also includes capture and sensitivity controls. Users can enable or omit attachments, temporary chats, financial information, health information, and other personal categories. Passwords, API keys, payment-card data, and account credentials are blocked from long-term storage by default.

Settings includes a checkpoint schedule. The default is every 10 minutes; users can choose a shorter 5-minute interval or a longer interval to reduce processing and model usage.

Settings will also include retrieval context budgets. The user can control the maximum number of text characters sent into an AI-tool context request, the maximum number of attachments included, and the maximum size of each attachment. These controls limit what is delivered for a particular retrieval request; they do not delete or change the underlying captured memory. When a limit or provider maximum truncates a result, Memory shows that truncation and preserves source links so the AI tool or user can request deeper evidence separately.

In the test build, Settings also offers **Run next summary**. It processes at most one eligible conversation using the selected provider and warns by context that the action sends the selected conversation slice to that provider and may use paid model credits. The automatic scheduler checks every five minutes but follows the workspace interval and remains idle until a model and API key are configured.

## 5. Key user flows

### Onboarding

1. Create an account.
2. Create or accept the default personal space.
3. Connect supported providers; automatic capture is enabled by default for ChatGPT, Claude, Gemini, and—if supported by the adapter—Perplexity.
4. Review or change capture settings, including pause, manual-only mode, and allowed sites.
5. Optionally connect Google Drive for import/export.
6. Choose default scope and retention; raw capture defaults to 30 days, with longer and `never delete` options.
7. Test retrieval with a visible sample context packet.

### Saving a memory

The user selects a message, document excerpt, or note and chooses “Save to shared memory.” They set scope, sensitivity, and optional expiration. The system shows the evidence before confirmation.

### Reviewing a summary

The user can open a checkpoint summary, see the source message range and chat link, edit the summary, or delete it. Editing creates a user-edited version and does not change the captured transcript. Any memory claims based on that summary are shown separately for review.

### Reviewing memory claims

The platform automatically creates provisional memory claims in the background. The Memory area presents them in a review queue with simple choices: “Yes, this is correct,” “No, this is incorrect,” and “Not sure.” Review is non-blocking; the system continues capturing and retrieving while claims wait for review, with confirmed claims receiving stronger priority.

The Conflicts & Facts review tab was removed from live navigation because candidate claims created too many low-value and cross-project decisions. Claim generation and claim retrieval were subsequently disabled in the backend.

### Using memory from an AI tool

The user enables the connector in the provider, selects permitted projects/scopes, and asks a normal question. The connector retrieves a small context packet. The user can inspect which memories were used.

### Resolving a conflict

The user sees both claims, their evidence, dates, and scopes. They can keep both as time-bound facts, confirm one, supersede one, or leave the conflict unresolved.

This is a future design direction, not the current Sherry experience. The prior implementation did not reliably establish shared project scope, genuine contradiction, or chronological order before presenting a pair, and “keep both” did not actually create time bounds.

### Deleting data

The user can delete a transcript, summary, or both. The product explains which memory claims, indexes, and evidence links will also be affected before the user confirms.

### Testing an integration

The user opens Diagnostics and runs a test conversation or capture scenario. The interface shows a step-by-step status trail: page detected, content captured, event uploaded, source stored, indexed, summarized, retrieved, and delivered to the connected AI tool. It also shows timestamps, latency, errors, retry status, and estimated summarization usage without exposing secrets.

Diagnostics also reports extension CPU/memory impact, upload size, page responsiveness signals, duplicate events, missed-event backfills, and the last captured message/checkpoint cursor.

### Connecting a device or native application

The user installs the relevant capture client, signs into Memory, and explicitly enables supported applications. The product explains whether each connection offers full automatic capture, capture while visible, structured hook capture, manual sharing, or import only. The user can pause an application or device immediately and inspect the last captured conversation, last event, queue state, gaps, and permission health.

### Importing previous conversations

The user uploads an official ChatGPT, Claude, or Gemini/Google Takeout archive. Before import, the product shows the provider, conversation count, date range, attachment volume, unsupported records, and estimated storage. Import progress and failures remain visible. The user can undo that import batch without deleting unrelated conversations. The product does not claim that a provider archive contains chats that were deleted, temporary, expired, or restricted by an administrator.

## 6. Product guardrails

- Automatic capture and cross-provider retrieval are separate controls: capture may be enabled by default after connection, while the user controls which scopes are available to each provider.
- Capture is enabled by default for supported providers after connection, with a visible pause control, per-provider controls, manual-only mode, and allowed-site settings.
- Native capture requires explicit device and application permission, strict application/package allow-listing, a visible active/paused state, and an immediate pause control.
- The product never describes an incomplete observed range as a complete conversation; coverage and gaps remain visible.
- The product distinguishes “captured,” “provisional memory,” and “confirmed memory.”
- Every memory claim can be traced to evidence.
- Generated summaries can be edited without rewriting the raw transcript.
- Provider-native memory is clearly labelled as outside the platform’s direct control.
- Conflicts are visible; stale information is not silently presented as current.
- Custom platforms require a compatible capture adapter; a URL alone is not treated as sufficient capture support.
- API keys used for testing are masked, encrypted, never logged, and removable from Settings.

## 7. MVP scope

Include:

- account authentication
- one personal space and projects
- Chromium/Brave and Firefox capture for visible ChatGPT, Claude, and Gemini conversations
- automatic opened-chat backfill for older browser conversations
- macOS and Windows companion proof-of-concept capture for ChatGPT and Claude desktop
- structured hook/session capture for Codex and Claude Code
- an Antigravity capture adapter using the most structured available plugin, hook, or session source
- Android proof-of-concept accessibility capture for ChatGPT, Claude, and Gemini, plus Share Sheet fallback
- official ChatGPT, Claude, and Gemini/Google Takeout historical import with deduplication and batch undo
- responsive web/PWA management on desktop and Android
- manual document upload and Google Drive sync
- raw source storage and searchable metadata/full text
- explicit notes and confirmed memory claims
- persistent checkpoint summaries with source links and editing
- one MCP read connector, with provider-specific adapters after the protocol is proven
- source inspection, permissions, retention, conflicts, and audit history
- Settings for profile, security, capture defaults, notifications, storage/export, and account controls
- Diagnostics for testing the capture-to-retrieval pipeline

Defer:

- replacing native provider chat interfaces
- automatic import of hidden provider-native memories
- automatic promotion of provisional claims to confirmed status without review
- team collaboration and complex enterprise administration
- OCR, audio/video transcription, and broad web crawling
- vector search until keyword retrieval and data quality are validated
- iOS native capture and an iOS management app
- public app-store distribution and store-policy certification; the Android MVP is a controlled proof of concept
- general-purpose capture of arbitrary desktop or mobile applications without a dedicated adapter
- screenshot/OCR capture unless a required proof-of-concept surface exposes no accessible or structured text

## 8. Success criteria for the prototype

- A user can capture a conversation, find it through the web console, and retrieve a relevant excerpt through MCP.
- A user can save a confirmed cross-platform memory with evidence and scope.
- A user can prevent a project memory from appearing in another project.
- A user can see and resolve a deliberately created contradiction.
- Disconnecting or deleting a source produces an understandable, auditable result.
- A user can complete the principal flows without needing to understand MCP, indexing, storage jobs, or other backend terminology.
- Every principal surface has intentional loading, empty, success, warning, error, disconnected, stale, and permission states where applicable.
- The web product is usable with keyboard navigation, visible focus, sufficient contrast, reduced motion, and responsive layouts.
- A real conversation can be captured from every required browser, desktop/coding-agent, Antigravity, and Android surface through the approved primary adapter or a clearly labelled fallback.
- Capture status distinguishes complete observed ranges from partial, gap-detected, fallback-only, and unsupported states.
- The same synchronized conversation observed on multiple devices or surfaces is represented once rather than becoming duplicate memory.
- Users can pause capture and inspect permissions, health, last activity, failures, and queued uploads per application and device.

## 9. Product decisions still open

- Product name and brand direction.
- Which native application adapters meet the full-automatic-capture standard after Gate 4B testing and which require a labelled fallback.
- Whether any required native surface needs screenshot/OCR after structured and accessibility approaches are tested.
- The technical limits and onboarding requirements for adding a custom platform adapter.
- Which sensitive categories require extra confirmation or exclusion.
- Whether automatic durable-claim promotion is available in the first release; persistent checkpoint summaries remain in scope.
- Pricing and storage quotas.
- Whether users need additional export formats beyond local files and Google Drive.
