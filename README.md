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

Current direction (September 2026): capture, conversation summaries, personal notes, source-backed retrieval, and the web console are active. Automatic memory-claim extraction and conflict review have been retired; historical claim/conflict rows are excluded from active retrieval. The user has closed the current Gate 8 work phase while original cross-device and accessibility items remain deferred. Complete the focused Gate 9 safety pass, then measure and improve retrieval in Gate 10, then finish broader Gate 9 pilot checks. See [`gate-9-safety-pass.md`](gate-9-safety-pass.md).
