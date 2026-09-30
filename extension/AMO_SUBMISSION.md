# Mozilla Add-ons submission — unlisted prototype

## Submission choice

- Distribution: **On your own / self-distributed**
- Visibility: **Unlisted**
- Add-on ID: `shared-memory-capture@memory.local`
- Version: `0.4.12`
- Minimum Firefox version: `140.0`
- Minimum Firefox for Android version: `142.0` (the current MVP is desktop-tested only)
- Privacy notice: `https://shared-memory-ingestion.mufaddal-m25.workers.dev/privacy`

## Build and verify

From the `extension` directory:

```bash
npm test
npm run check
npm run build:firefox
```

Upload the resulting `dist/sherry-capture-0.4.12.zip` to the Mozilla Add-ons Developer Hub. Do not upload a signed `.xpi` back to Mozilla; Mozilla creates the signed `.xpi` after validation. The add-on name shown to users is **Sherry Capture**; the add-on ID remains unchanged so a signed installation can update the existing add-on.

## Reviewer notes

Sherry Capture is a private prototype that captures visible messages from supported ChatGPT, Claude, and Gemini web conversations after installation. It sends those messages to the signed-in user's authenticated Memory workspace. The extension requests access only to the three supported AI sites, the project's Supabase origin, and the project's Cloudflare Worker origin. Cloud API requests require a Supabase user session and enforce workspace ownership server-side.

Firefox assigns a different `moz-extension://` UUID in every browser profile. The server therefore accepts CORS preflight from syntactically valid Firefox-extension origins, but CORS is not treated as authorization: every data request still requires a valid account token and access to the requested private workspace.

Technical and interaction data is optional. When the Firefox permission is not granted, the extension sends fixed withheld placeholders rather than an operating-system category or persistent pseudonymous device identifier.

The source package is plain JavaScript, HTML, and CSS. It is not minified, bundled, or generated, and it does not execute remote code.
