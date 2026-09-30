# Capture Ingestion API — Contracts v1 and v2

Status: v1 and backward-compatible v2 are deployed; provider-adapter validation continues in Gate 4B

## Purpose

The Capture API accepts small batches from the extension. It is the only place allowed to turn browser-observed messages into durable raw and searchable records. Summarization does not happen here.

Capture API v1 remains accepted during rollout. Capture API v2 adds the provenance needed for Firefox, desktop companions, coding-agent hooks/session adapters, Android accessibility/share capture, and historical imports. Both versions continue through the same redaction, ownership, deduplication, storage, indexing, deletion, and audit boundary.

## Cross-platform v2 envelope

The v2 contract adds capture-origin fields without changing the logical conversation event:

```json
{
  "schemaVersion": 2,
  "provider": "codex",
  "providerFamily": "openai",
  "product": "codex",
  "surface": "desktop",
  "captureClient": {
    "type": "structured_hook",
    "adapterVersion": "1.0.0",
    "deviceId": "device-pseudonymous-id",
    "os": "macos",
    "appVersion": "provider-app-version",
    "captureSessionId": "capture-session-id"
  },
  "coverage": {
    "state": "complete_observed_range",
    "gapBefore": false,
    "backfillAvailable": true
  },
  "events": [
    {
      "eventId": "evt_example",
      "provider": "codex",
      "conversationId": "provider-or-derived-session-id",
      "providerMessageId": null,
      "sequence": 0,
      "role": "user",
      "text": "Example message",
      "contentHash": "12ab34cd",
      "sourceUrl": null,
      "sourceLocator": "codex-session:local-session-id",
      "chatTitle": "Example session",
      "messageTimestamp": null,
      "capturedAt": "2026-09-17T19:00:00.000Z",
      "links": [],
      "attachments": []
    }
  ]
}
```

Native events may omit `sourceUrl` when no meaningful URL exists. They must instead provide a provider session ID or a derived `sourceLocator` that is stable on that device. The server resolves these identifiers into a canonical conversation and records the originating product, surface, adapter, and device as provenance.

V2 supports capture reasons `hook`, `accessibility`, `share`, `opened_chat_backfill`, and `historical_import` in addition to existing browser reasons. URL allow-list validation applies only when a URL is present; web capture still requires an approved provider URL. Native clients must supply a stable local `sourceLocator` when no URL exists.

The server stores v2 provenance in structured records for devices, capture adapters, ingestion batches, conversations, events, and cursors. Existing v1 records are backfilled with their known browser/provider defaults. The v2 function is service-role-only, and the two new tables are protected by workspace ownership policies.

When a page does not expose a durable provider message ID, the adapter uses a deterministic conversation-sequence-role identity. If an older adapter previously stored one unstable DOM identifier for the same unambiguous turn, v2 migrates that row to the deterministic identity rather than duplicating or dropping it. Ambiguous matches are left separate for review.

## Authentication

The extension sends the user's short-lived Supabase session access token:

```http
Authorization: Bearer <user-session-token>
```

The Worker validates that token with Supabase Auth. It then uses a separate Worker-only Supabase secret to call the protected ingestion transaction. The secret never reaches the extension.

The database transaction receives the verified user ID and independently checks that the user owns the requested workspace.

## Capture request

```http
POST /v1/capture/batches
Content-Type: application/json
Idempotency-Key: 5d667d30-8bed-4e63-b16e-9d5e928765c8
```

```json
{
  "schemaVersion": 1,
  "batchId": "5d667d30-8bed-4e63-b16e-9d5e928765c8",
  "workspaceId": "7c895c18-05e4-4f96-9148-37ad93b2a789",
  "provider": "chatgpt",
  "reason": "mutation",
  "clientCreatedAt": "2026-09-14T14:00:00.000Z",
  "events": [
    {
      "eventId": "evt_12ab34cd",
      "provider": "chatgpt",
      "conversationId": "conversation-123",
      "providerMessageId": "message-123",
      "sequence": 0,
      "role": "user",
      "text": "Remember that I prefer concise design reviews.",
      "contentHash": "12ab34cd",
      "sourceUrl": "https://chatgpt.com/c/conversation-123",
      "chatTitle": "Memory Test",
      "messageTimestamp": null,
      "capturedAt": "2026-09-14T14:00:00.000Z",
      "links": ["https://example.com/reference"],
      "attachments": []
    }
  ]
}
```

Rules:

- A batch contains 1–100 events and is at most 512 KiB.
- `batchId` is created once by the extension and reused unchanged for retries.
- `Idempotency-Key`, when present, must equal `batchId`.
- Every event in a batch belongs to the declared provider.
- Source-chat URLs must match the provider's approved host.
- Attachments in v1 are metadata only; binary upload is not part of this endpoint.
- Reusing a batch ID with changed content returns a conflict instead of overwriting the archive.

## Successful response

```json
{
  "ok": true,
  "requestId": "request-or-ray-id",
  "batchId": "5d667d30-8bed-4e63-b16e-9d5e928765c8",
  "rawObjectKey": "workspace/chatgpt/2026/09/14/batch.json",
  "redactions": {
    "total": 0,
    "byType": {},
    "events": []
  },
  "result": {
    "idempotentReplay": false,
    "status": "committed",
    "received": 1,
    "inserted": 1,
    "updated": 0,
    "duplicates": 0
  }
}
```

## Failure behavior

| Status | Meaning | Extension behavior |
| --- | --- | --- |
| `401` | Session is missing or expired | Pause uploads and ask the user to sign in again |
| `403` | User does not own the workspace | Pause uploads and show a workspace/account mismatch |
| `409` | Batch ID does not match, or was reused with changed content | Do not retry automatically; show a diagnostic error |
| `413` | Batch exceeds the byte limit | Split it into smaller batches |
| `422` | Event shape or provider URL is invalid | Quarantine the batch and show validation details |
| `502`/`503` | R2, Supabase, or authentication is temporarily unavailable | Retry the identical batch with exponential backoff |

No failure advances the server cursor.

## Durable redaction boundary

The Worker temporarily reads the submitted text in memory so it can identify forbidden credentials. Passwords, API keys, private keys, valid payment-card numbers, explicitly labelled financial-account credentials, and secret-bearing URL parameters are replaced before either R2 or Supabase receives the payload.

The redaction audit stores only categories and counts, never the removed values. User-controlled health, financial, and personal-memory category preferences remain a later policy filter; they are not the same as this non-optional credential safety boundary.

## Database deduplication order

Within the owned workspace and conversation, the transaction looks for an existing event by:

1. the extension event key;
2. provider message ID, when available.

Sequence and author role are not treated as unique identity because provider interfaces can reuse positions for distinct branches or messages. An identical content hash is counted as a duplicate. A changed hash updates the existing event as a new revision, which supports streaming responses without creating a second final message. Text search and the conversation cursor are updated inside the same transaction.
