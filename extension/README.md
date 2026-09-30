# Sherry Capture Extension — Gate 4B Browser Capture

Sherry Capture uses shared capture code with separate Chromium and Firefox/Zen manifests. It captures ChatGPT, Claude, and Gemini web conversations and uploads them through Capture API v2. The shared capture core carries provider family, product, web surface, pseudonymous device, adapter version, capture session, source locator, and coverage provenance. Version 0.4.12 recognizes ChatGPT's grouped user/assistant turns; 0.4.11 fixes recovery script paths for Zen/Firefox. Capture, attachment, temporary-chat, retry, and diagnostic controls live together on Sherry's Diagnostics page.

## What works

- ChatGPT, Claude, Gemini, and legacy ChatGPT host detection
- layered conversation/message selectors
- visible user and assistant message extraction
- conversation URL, title, message order, timestamps, links, and optional attachment metadata
- provider message ID with deterministic hash/sequence fallbacks
- streaming-response updates without duplicate records
- debounced mutation observation and lightweight URL-change detection
- automatic and manual capture controls
- extension-local event storage
- a Diagnostics page with scan duration, emitted counts, duplicates, errors, and captured records
- local JSON diagnostic export
- optional authenticated cloud sync configured from Diagnostics
- Capture API v2 batches with backward-compatible server ingestion
- stable pseudonymous device identity and per-service-worker capture session identity
- shared ChatGPT/Claude/Gemini provider definitions and Capture API v2 delivery
- dedicated Claude and Gemini DOM adapters using a common browser-provider runtime
- 100-event batching, local pending queue, idempotency keys, and exponential retry
- serialized capture/storage mutations so simultaneous initial and live scans cannot overwrite queued uploads
- deterministic sequence/role fallback identities when provider pages expose no durable message ID
- local and server-side migration of one unambiguous legacy DOM identity to the stable fallback
- repair of impossible historical sequence values before a batch is sent
- permanent-error pause for expired sessions, invalid batches, and workspace mismatches

## Privacy boundary

Cloud sync remains off until it is explicitly configured in Diagnostics. The extension stores up to 2,000 captured events, 500 diagnostic events, and 100 pending upload batches in extension-local storage. The temporary Gate 5 form stores a Supabase session access token in the current browser profile only and excludes it from status responses and JSON exports. Production web sign-in will replace this developer setup.

Capture correctness safeguards exclude transient “Thinking” statuses and reconcile provisional conversation identifiers with permanent provider URL identifiers. Matching provisional records can also be repaired after an extension or browser restart without merging ambiguous matches.

## Load in Chrome

Build the Chromium-specific package first with `npm run build:chromium`.

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `dist/sherry-capture-chromium-0.4.12` (not the Firefox/Zen source directory).
5. Open or reload a ChatGPT, Claude, or Gemini conversation.
6. Open the extension popup and choose **Open diagnostics**. The button opens the integrated Diagnostics page in Sherry rather than a separate extension page.

To test Gate 5 after a dedicated backend is deployed, open **Development cloud connection** in Diagnostics, enter the Worker URL, private workspace ID, and a short-lived Supabase session access token, then grant the exact Worker origin when Brave asks. Existing locally captured events can be queued as an initial backfill.

Installing an unpacked extension grants it access to visible content on the ChatGPT, Claude, and Gemini hosts listed in its generated `manifest.json`. Review those permissions before loading it. The generated ZIP can be used for Chromium distribution after store review; the unpacked directory is for local development.

## Permanent Firefox or Zen installation

Normal Firefox-based browsers require a Mozilla-signed `.xpi` for a permanent installation. Build the AMO upload archive with:

```bash
npm run build:firefox
```

Submit the generated ZIP as an unlisted/self-distributed add-on in the Mozilla Add-ons Developer Hub. After Mozilla signs it, install the downloaded `.xpi` from **Add-ons and themes → Settings → Install Add-on From File**. Refresh the Sherry Diagnostics tab after updating. If it still says the bridge is not connected, open the **Sherry Capture** add-on popup while on that tab and choose **Reconnect Sherry page**. The popup displays the installed version so you can confirm it is 0.4.12. On a provider tab, opening the popup now reconnects a missing capture adapter automatically; if Zen blocks access, check the add-on's site permissions. See `AMO_SUBMISSION.md` for the prepared submission details.

## Verify locally

```bash
npm test
npm run check
```

## Known limitations

- Provider page markup can change and break selectors.
- Temporary-chat detection is heuristic until verified against a signed-in temporary chat.
- Existing messages that are not rendered in the page cannot be captured.
- Edited and deleted-message reconciliation is intentionally deferred.
- Attachment capture records metadata only and is off by default.
- Claude capture has been live-validated in Brave and Zen/Firefox. ChatGPT, Claude, and Gemini have all delivered signed-in Zen/Firefox captures to the cloud.
- Gemini still requires a separate Brave/Chromium live pass because provider markup and browser behavior can change independently.
- The Chromium and Firefox packages are built from the same source, but capture should be smoke-tested in each browser after installation. Automated tests alone do not validate provider page markup or browser permissions.
- The current Firefox proof uses a temporary development add-on. The prepared `0.4.12` package becomes permanent after Mozilla signs it and the signed `.xpi` is installed.
