# Gate 8 UX/UI Plan — Memory

Status: historical first-pass brief; superseded for current IA decisions by [`gate-8-ia-review.md`](gate-8-ia-review.md) and its [interactive review map](planning/gate-8-ia-review/index.html)
Updated: Tue 2026-09-29

> This document preserves the September 22 starting hypothesis. Its claim/conflict-review paths and older page grouping are not active product requirements. Use the linked Gate 8A review draft and current roadmap for decisions now.

This document is the working starting point for Gate 8. It describes what exists, what the product needs to make visible, and what we need to settle before implementing the redesigned interface. It is deliberately a planning document, not a final visual design.

## Confirmed direction from the wireframe review

- Figma is the visual starting point, but Memory may improve naming, hierarchy, and interaction patterns when that makes the product clearer.
- The first Dashboard pass uses reliable basics such as chat counts, provider activity, and processing health. Deeper insight cards remain part of Gate 8's second pass.
- Personal Memory is a separate user-owned area. Users can add claims themselves, while onboarding may suggest initial entries from captured chat information.
- Connected Conversations is a separate surface from Conflicts & Facts.
- Search is section-based. The interface must clearly tell the user which section is being searched.
- Codex, Claude Code, and Antigravity appear as coming-soon options until their capture paths are validated.
- Missing product surfaces—onboarding, connections, Settings, Diagnostics, review, retrieval inspection, and data control—will be designed in the same visual language based on the product specification.

## 1. Gate 8 objective

Turn the working web console and capture tools into one coherent Memory product.

The web app should be the main place where a user understands and controls their data. Browser extensions and future desktop/mobile capture clients should remain lightweight companions for permissions, pause/resume, status, and opening the main product.

The interface must make these things understandable without requiring the user to know backend terms such as indexing, cursors, queues, or MCP:

- what Memory captured
- where it came from
- what was summarized
- what became a proposed or confirmed memory
- what an AI provider is allowed to retrieve
- whether anything is delayed, incomplete, or failing
- what will be deleted, exported, or disconnected

## 2. Current prototype inventory

The existing web console proves important workflows, but its navigation and labels are still provisional.

### Current surfaces

1. **Authentication**
   - Sign in to the Memory account.
   - Sign out.

2. **Dashboard / Chat Memory**
   - Conversation list.
   - Provider, title, message count, capture status, and last activity.
   - Conversation detail dialog.
   - Link back to the original provider chat.
   - Summarize, export, and delete actions.

3. **Personal Memory / Summaries**
   - Generated summaries.
   - Summary detail and editing.
   - Exact source-message evidence.
   - Summary version history.
   - Independent summary deletion.

4. **Conflicts & Facts / Memory review**
   - Provisional and confirmed memory claims.
   - Yes, No, and Not sure review actions.
   - Conflicts between claims.
   - Evidence and resolution actions.

5. **Shared Conversations / Settings**
   - Automatic summarization and schedule.
   - Test summarizer provider, model, and API-key controls.
   - Retrieval connections.
   - MCP endpoint information.
   - Retrieval test area.

6. **Extension diagnostics**
   - Capture status, upload queue, retries, errors, and provider checks.
   - This is currently separate from the main web console and is one of the Gate 8 consolidation problems.

## 3. Proposed information architecture

This is a working hypothesis to test against the user's rough wireframes. It is not yet final.

### Home

The starting point after sign-in:

- overall capture and processing health
- recent conversations and summaries
- unresolved memory reviews or conflicts
- active projects
- clear action when something needs attention

### Memory

The durable, user-controlled knowledge area:

- confirmed memories
- provisional memories awaiting review
- superseded memories
- conflicts
- evidence, dates, scope, and source links
- edit, confirm, reject, and delete controls

### Sources

Everything Memory learns from:

- captured conversations
- connected providers
- uploaded documents and attachments
- user-created notes
- source metadata such as provider, chat title, URL, and timestamps

### Projects

Private scopes for organizing memory:

- project overview
- included sources and notes
- project-specific memories
- retrieval permissions and scope

### Activity / Timeline

An understandable history of what happened:

- capture events
- uploads and retries
- indexing
- summaries
- memory-claim changes
- imports, exports, edits, and deletions

### Connections and Devices

The control area for capture surfaces:

- ChatGPT, Claude, Gemini, and later providers
- browsers and extension profiles
- desktop and Android companions when available
- permissions, pause/resume, last activity, queue state, and coverage gaps

### Settings

Settings should be a first-class product surface, divided into understandable groups:

- profile and account security
- capture behavior and provider toggles
- attachments and temporary chats
- sensitivity categories
- summarization and test-model controls
- retrieval permissions and context budgets
- storage, retention, export, and deletion
- notifications and failure alerts
- application preferences

### Diagnostics

A technical testing area for the user and development team:

- capture-to-retrieval pipeline test
- provider and device health
- failed, quarantined, or paused work
- latency and upload information
- indexing and summarization status
- prevented model calls and cost-protection events

Diagnostics should be easy to reach when something is wrong, but should not dominate normal daily use.

## 4. Core flows Gate 8 must support

These are the flows the wireframes need to cover, including their important edge states.

1. **First use and connection**
   - Create an account.
   - Connect a provider or browser.
   - Understand what is captured and what is shared.
   - See a successful first capture.

2. **Daily use**
   - Open Memory and immediately understand whether it is healthy.
   - Find a conversation or memory.
   - Open the original source chat.

3. **Review and correction**
   - Review a proposed memory.
   - Confirm, reject, or mark it uncertain.
   - Edit a summary without changing the raw transcript.
   - Resolve or postpone a conflict.

4. **Retrieval inspection**
   - See which memory was returned to an AI provider.
   - Understand why it was selected.
   - See source links, uncertainty, truncation, and context-budget limits.

5. **Control and privacy**
   - Pause a provider or device.
   - Change capture and sensitivity settings.
   - Delete a transcript, summary, claim, or complete source.
   - Export the workspace.

6. **Failure recovery**
   - Understand what stopped.
   - Know whether data is safe or waiting locally.
   - Retry safely without spending model credits unnecessarily.
   - See when user action is required.

## 5. Required state inventory

Every relevant surface should have an intentional version of these states:

- first-use onboarding
- loading
- empty, with a useful next action
- ready with realistic content
- partial or gap-detected capture
- paused or disconnected
- waiting for processing
- stale index or delayed processing
- conflict or uncertain memory
- permission denied
- failure with plain-language recovery guidance
- retrying
- destructive-action confirmation
- success confirmation
- provider or source link unavailable
- content truncated by a retrieval limit

## 6. Gate 8A deliverables

Gate 8A is complete when we have:

- an agreed navigation and information architecture
- a screen inventory mapped to the main user flows
- rough wireframes for the key surfaces
- a state matrix for normal, empty, loading, warning, error, and destructive states
- agreed terminology for conversation, source, summary, memory, claim, evidence, project, and connection
- a responsive and accessibility baseline to carry into visual design

Gate 8B starts after this point and defines the visual tokens, reusable components, interaction rules, and Linear-informed patterns.

## 7. What I need from the user

Please provide the first rough wireframes whenever ready. They can be screenshots, sketches, a PDF, a Figma export, or hand-drawn layouts.

The most useful first set would cover:

1. Home / overview
2. Memory list and memory detail
3. Sources or conversations list and detail
4. Settings
5. Diagnostics or failure state

If the wireframes do not cover every state yet, that is fine. We will use them to establish the intended hierarchy first, then fill in missing states before implementation.

## 8. Explicit non-goals for this step

- No frontend redesign is being implemented yet.
- No final navigation labels are being treated as approved.
- No new backend behavior is being added.
- No visual styling is being copied from Linear; Linear is only a reference for interaction and interface quality.
- User-created Personal Memory entries are currently a frontend prototype backed by browser-local draft storage; a durable cloud note endpoint is still required before this becomes production behavior.
