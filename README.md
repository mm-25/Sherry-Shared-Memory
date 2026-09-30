# Shared AI Memory Platform

This workspace contains the first design drafts for a cloud memory layer shared across ChatGPT, Claude, Gemini, and connected sources.

- [Memory policy](memory-policy.md)
- [Data model](memory-data-model.md)
- [Retrieval and MCP protocol](retrieval-mcp-protocol.md)
- [Product specification](product-spec.md)
- [MVP roadmap](mvp-roadmap.md)
- [Technical architecture](architecture.md)
- [Gate 4 browser-extension prototype](extension/README.md)
- [Capture Ingestion API](ingestion-api.md)
- [Gate 5 cloud ingestion service](backend/README.md)
- [Gate 6 summarization pipeline](summarization-pipeline.md)

Current direction (September 2026): capture, conversation summaries, personal notes, source-backed retrieval, and the web console are active. Automatic memory-claim extraction and conflict review have been retired; historical claim/conflict rows are excluded from active retrieval. The user has closed the current Gate 8 work phase while original cross-device and accessibility items remain deferred. Complete all of Gate 9 before moving to retrieval measurement in Gate 10. A controlled Gate 9 test found a duplicate raw archive left after chat deletion; the database guard is live and the Worker cleanup repair is awaiting deployment. See [Gate 9 safety evidence](gate-9-safety-pass.md) and [pilot checklist](gate-9-pilot-checks.md).
