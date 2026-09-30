# Gate 9 pilot checks

_September 30, 2026. Gate 9 is in progress. This page records the wider release checks in plain language. The focused privacy and import evidence is in [Gate 9 safety pass](gate-9-safety-pass.md)._

## What a Gate 9 pass would mean

A small group of invited people can connect supported AI tools, import or capture their conversations, find the right stored records, control AI access, export their data, and delete it without hidden copies or silent gaps. We must observe this on the actual products and devices in scope. Passing unit tests alone is insufficient.

## Evidence by area

| Area | Current evidence | Next proof needed |
| --- | --- | --- |
| Browser capture speed | The Firefox/Zen extension and Chromium package pass 47 local tests. Zen/Firefox previously delivered live ChatGPT, Claude, and Gemini batches. | Measure capture delay, queue drain time, page responsiveness, and memory use on ChatGPT, Claude, and Gemini in both Firefox and Chromium. Repeat after long chats, streaming answers, navigation, and browser restart. |
| macOS, Windows, Android | The repository contains a browser extension, web app, and backend. The planned macOS and Windows capture companions and Android capture app have not been built. | Build the companions and Android proof of concept, then test every supported application and both conversation sides on real target devices. |
| OS permissions and app allow-list | Browser host-permission behavior has local tests, including Firefox's direct click requirement. Native accessibility permission handling does not exist yet. | On each desktop and Android app: grant, deny, revoke, restart, and recover permission. Confirm only explicitly allowed apps can be observed. |
| Queues, restarts, and offline recovery | The browser extension has local retry, bounded queue, and identity repair tests. | Disconnect network, capture new messages, restart browser/device, reconnect, and compare every source message ID with local queue and cloud records. Repeat across app updates and multiple devices. |
| Imports and undo | A synthetic two-message ChatGPT export passed live import, readback, and duplicate replay. Claude overlap and uncertain matches have local tests. | Near the end, use official ChatGPT, Claude, and Gemini exports as the user requested. Try malformed files, interrupted upload, overlapping archives, missing IDs, and a reversible import-batch undo. Import-batch undo is not built. |
| Source links | Stored conversations expose a source URL when one is available. | Open links for each provider while signed in, signed out, and after the source is removed or its URL expires. Confirm Sherry explains broken or inaccessible links. |
| Connected AI tools | The connected Sherry AI tool passed live search, category denial, provider-permission denial, and source-lookup checks. The earlier Claude baseline was reported in the roadmap. | Run the same deployed tool contract through ChatGPT, Gemini, and Grok. Verify stale or read-only tokens and a second real user account. |
| Summarization cost | From September 27–29, 132 completed jobs used 840,216 input and 150,215 output tokens on Claude Haiku 4.5; one job failed. Using Anthropic's published [$1 input and $5 output per million tokens](https://platform.claude.com/docs/en/about-claude/pricing), the completed-job estimate is **$1.59 total**, about **$0.012 per completed job**. The median completed job used 7,588 total tokens. Local code now records an estimated cost for future Haiku 4.5 jobs and labels it as an estimate in the summary view. | Deploy the cost estimator and compare with the provider's billed amount. Existing jobs have no stored cost value, and failed requests have no token records. The estimate is a lower bound on possible billed cost. |
| Privacy, export, deletion | Individual chat deletion and category switches exist. The local export now includes chats, summaries, and Personal Memory notes. The local privacy notices describe these controls and their limits. | Deploy and verify the archive cleanup fix and expanded export. Build and test whole-workspace/account deletion, including raw R2 archives and connected AI tokens. The current whole-workspace delete button is now disabled and labelled unavailable instead of offering a placeholder alert. |
| Private pilot | One real Sherry account exists, with no account-creation screen. | Establish the pilot account-creation policy, invite participants, run the scenario matrix, record observed failures, fix serious issues, and repeat. A one-account developer check is not a private pilot. |

## Minimum repeatable pilot script

For each supported provider and device:

1. Connect the Sherry account and explicitly grant capture permission.
2. Create a new chat with a distinctive test phrase and at least one user and one assistant message.
3. Check that Sherry shows the correct source, order, date, and message count. Compare the source IDs when the provider exposes them.
4. Edit or continue the same chat. Check that updates replace the correct message and do not make extra copies.
5. Go offline, create another message if the source allows it, restart the browser or app, and reconnect. Check that the queue catches up without a gap or duplicate.
6. Turn one AI-access category or provider permission off. Confirm the connected AI tool cannot search or open the withheld source; restore it.
7. Export Sherry data and confirm the test chat and any associated summary or Personal Memory note appear.
8. Delete the test chat. Confirm transcript, search, source lookup, and every raw archive copy are gone. Revisit the original provider chat and confirm Sherry does not silently recapture the deleted ID.

Use invented content only. Record platform, provider, app/extension version, time, expected message IDs or counts, Sherry counts, and any visible failure. A successful stored count does not prove that a source message was never omitted.

## Gate decision

**Not passed.** The raw archive remnant found in the synthetic duplicate-import test remains until the Worker repair is deployed and verified. Whole-workspace deletion, import undo, native capture apps, a second Sherry account, official-export trials, and a real private pilot are also missing. The checklist is an evidence ledger, not a declaration that those features work.
