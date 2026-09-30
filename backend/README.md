# Gate 5–6 cloud service

This package is the cloud boundary between browser capture, durable storage, summarization, and MCP retrieval.

Current status (September 2026): automatic claim extraction and conflict generation are retired. New claim inserts are blocked in the database; historical claims and conflicts are retained but excluded from search and active APIs. Summaries, transcripts, and explicit notes remain active.

## What is implemented

- `POST /v1/capture/batches` with Supabase user-session authentication
- strict versioned validation for ChatGPT, Claude, and Gemini event batches
- credential, payment-card, labelled financial-account, and secret-bearing URL redaction
- deterministic, immutable raw archives in Cloudflare R2
- one Supabase transaction for source/conversation upserts, event deduplication, text indexing, links, diagnostics, and cursor advancement
- idempotent retry protection: a reused batch ID must contain byte-for-byte equivalent redacted content
- RLS-protected read access for a user's private workspace
- an authenticated web console for viewing and exporting captured conversations
- permanent conversation deletion across Supabase search records and shared R2 archives
- deletion tombstones that prevent the extension from silently re-importing removed chats
- no Supabase secret or service-role key in the extension
- authenticated `GET` and `PUT /v1/settings/summarizer` endpoints with workspace ownership checks
- server-side AES-GCM encryption for test summarizer API keys, with only a masked hint returned to the browser
- a live Settings page for automatic summarization, interval, provider, model, and advanced checkpoint timing
- a provider-neutral structured summarization gateway for Anthropic, OpenAI, Google Gemini, and xAI Grok
- source-event citation validation, bounded provider responses, retry classification, normalized token usage, and xAI-reported exact cost support
- a Cloudflare Cron Trigger that wakes every five minutes and respects each workspace's selected summary interval
- authenticated `POST /v1/summaries/run` for one user-requested eligible summary
- atomic job claiming, stale-job recovery, bounded retry backoff, source-revision checks, and transactional checkpoint/evidence persistence
- authenticated Summary and Memory views with exact source-message inspection and model-usage metadata
- atomic summary edit/delete operations

The service and web console are deployed at `https://shared-memory-ingestion.mufaddal-m25.workers.dev`. They use the dedicated `Memory V1` Supabase project and do not use the unrelated `Wisp` project.

The web console uses authenticated backend data by default. Append `?preview=1` only for the explicit design preview. Dashboard metrics, conversations, summaries, Personal Memory, retrieval permissions, diagnostics, and settings read from workspace-scoped APIs; preview records are never mixed into live mode.

## Storage order

1. Validate the signed-in user with Supabase Auth.
2. Validate and redact the batch in memory.
3. Write the redacted raw archive to R2 under a deterministic key.
4. Call the private Supabase ingestion transaction with the Worker-only secret key.
5. Insert/update searchable metadata and advance cursors in the same database transaction.
6. If the database transaction fails for a newly created object, remove that R2 object and leave the cursor unchanged.

This means a cursor never claims that an event is safe until both storage layers have accepted it.

## Local checks

```bash
npm install
npm test
npm run check
npm run types
npx wrangler deploy --dry-run
```

The Worker tests use in-memory R2 and mocked Supabase/model-provider responses. Database tests run migrations and transactions in an embedded PostgreSQL engine, including regression coverage for retired claim insertion and claim-free search. Service and gateway tests cover scheduled/manual execution, safe retries, key isolation, and structured output for Anthropic, OpenAI, Google Gemini, and xAI Grok without paid model calls. Ninety tests currently pass. The embedded engine does not bundle `pgcrypto`, so the test omits only that extension declaration; the checked-in Supabase migration keeps it. The live Supabase project is additionally checked with Supabase's security and performance advisors after DDL changes.

## Configure a dedicated environment

1. Create a dedicated Supabase project and R2 bucket. Do not reuse an unrelated production project.
2. Copy `.dev.vars.example` to `.dev.vars` for local development.
3. Put the Supabase URL and publishable key in the environment.
4. Store `SUPABASE_SECRET_KEY` and a random 32-byte base64 `SETTINGS_ENCRYPTION_KEY` as Cloudflare Worker secrets. Never put either value in the extension, web bundle, logs, or committed files.
5. Apply `supabase/migrations/20260914141327_gate_5_ingestion_pipeline.sql` to the dedicated Supabase project.
6. Bind the R2 bucket as `RAW_MEMORY` and configure the exact extension/web origins allowed to call the Worker.

## Endpoint

The full request and response contract is documented in [`../ingestion-api.md`](../ingestion-api.md).

Summarization endpoints:

- `GET /v1/settings/summarizer?workspaceId=<uuid>` reads safe, browser-visible settings.
- `PUT /v1/settings/summarizer?workspaceId=<uuid>` saves settings and encrypted test-key changes.
- `POST /v1/summaries/run?workspaceId=<uuid>` runs at most one eligible conversation update; an optional JSON body may provide `conversationId`.
- `GET /v1/summaries?workspaceId=<uuid>` and `GET /v1/summaries/<id>` return active summaries, exact evidence, usage, and version history.
- `PUT /v1/summaries/<id>` creates a user-edited version; `DELETE` removes generated summary text while retaining the source cursor and transcript.
- `GET /v1/memories`, `POST /v1/memories/<id>/review`, and `POST /v1/conflicts/<id>/resolve` return HTTP 410 because claim/conflict review is retired.

The scheduled handler and manual endpoint use the same selector, job functions, gateway, and persistence path, so they cannot produce two different kinds of memory.
