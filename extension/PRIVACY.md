# Sherry Capture privacy notice

Updated: September 30, 2026

Sherry Capture is a private browser-extension prototype that copies supported AI conversations into the user's Memory workspace so the user can retrieve context across AI providers.

## Data the extension handles

When capture is enabled, the extension can handle:

- visible user messages and AI responses on supported ChatGPT, Claude, and Gemini pages;
- conversation titles, page URLs, message order, timestamps, and links;
- attachment names and metadata when attachment capture is enabled;
- the user's Memory account email and authentication session;
- health, financial, identifying, or other sensitive information when that information appears in a captured conversation; and
- limited technical information, such as extension version, operating-system category, a pseudonymous installation identifier, and a session identifier, only when Firefox technical-data permission is enabled.

The extension does not intentionally collect deleted messages or temporary chats by default. Attachment capture is off by default.

## Why the data is used

Captured information is used to provide the user's Sherry workspace: conversation storage, summaries, Personal Memory notes, retrieval, source attribution, synchronization, diagnostics, deletion, and export. Sherry no longer creates new automatic memory claims.

## Where data is sent and stored

The extension sends captured data over HTTPS to the Memory ingestion service hosted on Cloudflare Workers. Raw archives are stored in a private Cloudflare R2 bucket. Structured workspace data and account authentication are hosted in Supabase.

The ingestion service looks for common password, API-key, private-key, payment-card, and labelled-credential patterns and replaces matches before durable storage. Automatic pattern matching may miss unfamiliar secret formats. The Sherry account password is sent directly to Supabase for authentication and is not saved by the extension. Session tokens are stored only in the browser profile and are excluded from diagnostic exports.

## User controls

The user can pause capture, choose whether attachments and temporary chats are included, disconnect cloud synchronization, inspect captured conversations and their source links, export chats, summaries, and Personal Memory notes, and delete individual stored conversations. Financial, Health, and Personal switches keep stored information in Sherry but withhold disabled categories from connected AI tools. When any switch is off, unlabelled chats and summaries are also withheld from connected AI tools. Disconnecting synchronization does not delete data already stored in Sherry. Deleting an entire workspace or account is not yet available in the private prototype.

## Sharing and sale

Memory does not sell captured data and does not use it for advertising. Data is processed by Cloudflare, Supabase, and a user-selected summarization provider only as needed to provide the configured service.

## Retention

Captured data remains in the user's workspace until deleted by the user. There is currently no automatic workspace retention setting. Extension-local diagnostic and capture records are bounded to prevent unlimited browser storage growth.

## Prototype status

This is an unlisted prototype intended for private testing. Its privacy controls and storage design will be reviewed again before any public release.
