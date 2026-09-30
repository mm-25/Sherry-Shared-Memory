# Gate 8A information architecture review and 8B state inventory

Status: draft for user review, not a finalized navigation decision
Updated: Tue 2026-09-29

Open the [interactive review map](planning/gate-8-ia-review/index.html). It works without a backend, so exploring or annotating it cannot change Sherry data. The Sitemap distinguishes **in app now**, **partial**, and **proposed** areas; User flows show the paths between them; State inventory lists 26 concrete moments and their current coverage. Each area now explains today's experience, why the question matters, two or three realistic directions, my starting recommendation, and what is still outside the decision. The user can select a direction, set its priority for after Gate 9, and add a different idea in their own words. Notes stay in that browser's local storage until downloaded from My review as JSON.

The map is not asking the user to approve 16 new screens. In particular, a **proposed** area may become a section within an existing screen, or may be deferred entirely. “In app now” does not mean complete or verified.

## Scope and sequencing

- Work now: Gate 8A wider information architecture and Gate 8B state inventory/design questions, alongside the separate focused Gate 9 safety pass.
- Set aside for now: accessibility audit and remediation. Existing accessibility features are not a completed verification.
- Hold: all Gate 8C product expansion until Gate 9 is finished, then Gate 8D validation until 8C is implemented. This does not change the Gate 9 → Gate 10 retrieval sequence recorded in the roadmap.
- This artifact proposes paths; it does not add routes, connect providers, change permissions, or touch production data.

## Current navigation and proposed additions

| Area | Current location | Status | Review decision needed |
| --- | --- | --- | --- |
| Sign in / out | Outside signed-in shell | In app | How account creation and recovery enter the flow |
| Dashboard | Sidebar | In app | Which metrics need clearer evidence and empty states |
| Chat Memory | Sidebar | In app | Where the boundary to a future Sources view lies |
| Personal Memory | Sidebar | In app | How explicit AI-written notes are identified and accessed |
| Connected Conversations | Sidebar | In app | How to explain links between chat nodes |
| Diagnostics | Sidebar | In app | Which problems deserve ordinary user language versus technical detail |
| Summarization | Settings | In app | Pending/failure/staleness language |
| AI connections and retrieval | Settings | Partial | Connection, account, and disconnect model |
| Import and export | Settings → Account & data | Partial | Full-workspace export and import recovery |
| Deletion and retention | Chat/summary/note detail; Settings | Partial | Full-workspace deletion and retention |
| First-use setup | No route | Proposed | Guided first capture and consent |
| Sources | No dedicated route | Proposed | New destination or extension of Chat Memory? |
| Timeline / activity | No dedicated route | Proposed | Which events belong outside Diagnostics? |
| Projects / scopes | No user-managed route | Proposed | Scope model and information hierarchy |
| Retrieval inspection | Test query only, not per-call history | Proposed | What can be shown safely per retrieval? |
| Connections and accounts | Split between Settings and Diagnostics | Proposed | One home for provider accounts and capture surfaces? |

“Conflicts & Facts” is retired and is deliberately absent from the active map. Its hidden legacy markup in `web/index.html` does not make it a live destination. Automatic claim generation/retrieval is retired; do not revive it through a sitemap decision.

## Vocabulary to agree before route changes

- **Chat / conversation:** a source exchange captured from an AI provider or imported from an official export.
- **Summary:** a generated or user-edited representation of one conversation; not the raw transcript.
- **Personal Memory:** user-owned explicit notes and categories, distinct from generated summaries.
- **Source:** the original item and its provenance (chat, imported record, note, or future attachment). A dedicated Sources route is not yet approved.
- **Connection:** an AI provider's retrieval permission or a capture surface's connection; these are currently split and should not be conflated.
- **Project / scope:** a future user-managed boundary for organizing and restricting retrieval; the app does not yet expose full project management.
- **Diagnostics:** technical health and recovery information; a future Timeline would instead explain meaningful user activity.

## Flow decisions for the review

1. **First use:** existing-account sign-in → proposed setup → proposed connection management → Diagnostics → first Chat Memory item. Account creation and guided consent remain open.
2. **Find a chat:** Dashboard → Chat Memory → chat detail/source link → possible Sources or Timeline. The last two are not yet built.
3. **Correct memory:** Chat Memory summary edit or Personal Memory note edit → potential Timeline event. Editing a summary does not edit transcript messages.
4. **Explore relationships:** Connected Conversations → Chat Memory detail. A future retrieval explanation may link to the same source; current graph connections should not be treated as factual conflicts.
5. **Let an AI retrieve:** Settings permission → test result → future per-request retrieval inspection → source chat. Gate 10 owns ranking quality, while Gate 9 owns access safety.
6. **Import/export:** Settings import → Chat Memory → Diagnostics if processing fails. Current “workspace export” is conversations only, not full backup.
7. **Pause/recover/delete:** Diagnostics or future Connections → individual deletion or future whole-workspace deletion → future activity record. Gate 9 must prove deletion propagation before a completed-state promise.

## Gate 8B state inventory status

The interactive map contains the complete 26-row inventory, including each user's information need, present/partial/not-built coverage, and next design question. It covers:

- Entry: session expiry, new empty workspace, loading and slow requests.
- Understanding: metric provenance, no retrieval history, empty search, partial transcripts, unavailable source links, graph weak links.
- Capture/processing: extension absent or paused, permission denied, offline queue, failed upload/retry, pending or failed summary.
- Retrieval: disabled access, stale index versus no match, truncation and source evidence.
- Data control: import preview/overlap/partial failure/undo, incomplete export, deletion confirmation/progress/partial completion/recapture, personal-note edits.
- Scope and surfaces: project/provider-account mismatch, narrow-screen and assistive-technology behavior. Accessibility verification is recorded but intentionally deferred.

“Present” means there is a real current UI pattern, not a tested end-to-end state guarantee. “Partial” means some UI exists but the full state/recovery explanation is unverified. “Not built” is a genuine gap. The inventory is ready for review; implementation and systematic verification remain unchecked in `mvp-roadmap.md`.

## Decisions worth reviewing first

1. **Chat Memory versus Sources.** Today Chat Memory already lets people inspect conversations, transcripts, summaries, and source links. A separate Sources page would only help once Sherry has other source types—such as browseable attachments, files, and AI-saved notes—and can avoid showing the same conversations twice. My starting recommendation is to keep Chat Memory focused for now, define a shared source-detail model, and defer the separate route until non-chat sources are real. The alternative is to broaden and rename Chat Memory into one source library.
2. **Personal Memory versus AI-saved notes.** Notes typed into Personal Memory are visible and editable, but notes explicitly saved through a connected AI are searchable without a clear browse location. My starting recommendation is to show both in one notes area with a visible origin, date, and source; the alternative is a separate AI-saved list. This decision is about access and ownership, not bringing back automatic claims.
3. **AI connections versus browser capture.** Settings controls what an AI may search or explicitly save; Diagnostics controls what the extension captures and uploads. These are different permissions even when the provider has the same name. My starting recommendation is to keep them distinct until a true Connections home can show provider accounts and capture devices together. A single switch must not imply that capture and retrieval are the same operation.
4. **Timeline and Projects.** A Timeline could show when capture, import, editing, retrieval, and deletion occurred, but a global feed may be noisy; contextual history inside each chat or operation may be enough. Projects could prevent unrelated contexts from being mixed, but their access boundary must be defined before promising isolation in a UI. Both are explicit proposals, not approved destinations.
5. **Most urgent current-web states.** The 26 examples in the State inventory make specific failures discussable: partial transcript, queued or failed upload, summary older than the chat, unavailable source, incomplete export, or uncertain deletion. Pick the ones that most undermine trust now; the inventory does not assert that any are already fully solved.

## Evidence used

- Current web navigation, dialogs, and controls: [`web/index.html`](web/index.html) and [`web/app.js`](web/app.js).
- Gate 8 delivered/open split: [`mvp-roadmap.md`](mvp-roadmap.md).
- Earlier UX plan (historical; its claim/conflict and proposed hierarchy sections are not current decisions): [`gate-8-ux-plan.md`](gate-8-ux-plan.md).
- First-pass and signed-in audits: [`design-qa.md`](design-qa.md), [`audits/2026-09-24-platform-review/audit-report.md`](audits/2026-09-24-platform-review/audit-report.md), and [`audits/2026-09-25/report.md`](audits/2026-09-25/report.md).
- Current safety boundary: [`gate-9-safety-pass.md`](gate-9-safety-pass.md).
