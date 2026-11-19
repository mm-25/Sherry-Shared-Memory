const MAX_EVENTS_PER_BATCH = 100;
const MAX_QUEUE_BATCHES = 100;
const MAX_SAFE_BATCH_BYTES = 450_000;
const PROVIDER_FAMILIES = Object.freeze({ chatgpt: "openai", claude: "anthropic", gemini: "google" });

function isHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function sanitizeCaptureEvent(event, fallbackSequence = 0) {
  const sequence = Number.isInteger(event?.sequence)
    && event.sequence >= 0
    && event.sequence <= 1_000_000
    ? event.sequence
    : fallbackSequence;
  return {
    ...event,
    sequence,
    sourceLocator: typeof event?.sourceLocator === "string" && event.sourceLocator.trim()
      ? event.sourceLocator.trim().slice(0, 1024)
      : `web:${event?.provider || "chatgpt"}:${event?.conversationId || "unknown"}`,
    links: [...new Set((Array.isArray(event?.links) ? event.links : []).filter(isHttpsUrl))].slice(0, 50),
    attachments: (Array.isArray(event?.attachments) ? event.attachments : [])
      .filter((attachment) => attachment && typeof attachment === "object" && !Array.isArray(attachment))
      .slice(0, 25)
  };
}

export function normalizeIngestionEndpoint(value) {
  const url = new URL(String(value || "").trim());
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("The ingestion endpoint must use HTTPS, except for localhost development.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/capture/batches`
    .replace(/\/v1\/capture\/batches\/v1\/capture\/batches$/, "/v1/capture/batches");
  return url.toString();
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

export function selectConversationCaptures(events, provider, conversationId) {
  if (!["chatgpt", "claude", "gemini"].includes(provider)
    || typeof conversationId !== "string"
    || !conversationId.trim()
    || conversationId.length > 512) {
    throw new Error("Open a supported conversation before repairing its upload.");
  }
  return (Array.isArray(events) ? events : []).filter((event) =>
    event?.provider === provider && event.conversationId === conversationId);
}

export function createCaptureBatches(events, config, reason, options = {}) {
  if (!Array.isArray(events) || !events.length) return [];
  if (!isUuid(config.workspaceId)) throw new Error("A valid workspace ID is required.");
  const createId = options.createId || (() => crypto.randomUUID());
  const now = options.now || (() => new Date().toISOString());
  const groups = new Map();

  for (const event of events) {
    const provider = event.provider || "chatgpt";
    const providerEvents = groups.get(provider) || [];
    const sanitized = sanitizeCaptureEvent(event, providerEvents.length);
    // Capability applies only when constructing new immutable payloads.
    // Local source evidence and already frozen requests are never rewritten.
    if (options.capabilities?.sourceMetadataVersion !== 1) delete sanitized.sourceMetadata;
    providerEvents.push(sanitized);
    groups.set(provider, providerEvents);
  }

  const batches = [];
  for (const [provider, providerEvents] of groups) {
    const providerFamily = providerEvents[0]?.providerFamily || PROVIDER_FAMILIES[provider];
    if (!providerFamily) throw new Error(`Unsupported capture provider: ${provider}`);
    const coverage = options.coverage || {
      state: "complete_observed_range",
      gapBefore: false,
      backfillAvailable: ["initial_scan", "initial_backfill", "repair_backfill", "opened_chat_backfill"].includes(reason)
    };
    const captureClient = {
      type: "browser_dom",
      adapterVersion: config.adapterVersion || "0.2.0",
      deviceId: config.deviceId || "legacy-browser-device",
      os: config.os || "unknown",
      appVersion: config.appVersion || null,
      captureSessionId: config.captureSessionId || "legacy-browser-session"
    };
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      batches.push({
        schemaVersion: 2,
        batchId: createId(),
        workspaceId: config.workspaceId,
        provider,
        providerFamily,
        product: provider,
        surface: "web",
        reason,
        clientCreatedAt: now(),
        captureClient,
        coverage,
        events: pending
      });
      pending = [];
    };
    for (const event of providerEvents) {
      const candidate = [...pending, event];
      const candidateBytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
      if (pending.length && (candidate.length > MAX_EVENTS_PER_BATCH || candidateBytes > MAX_SAFE_BATCH_BYTES)) flush();
      pending.push(event);
    }
    flush();
  }
  return batches;
}

export function createConversationMetadataBatches(observations, config, options = {}) {
  if (options.capabilities?.sourceMetadataVersion !== 1 || options.capabilities?.conversationUpdatesVersion !== 1) return [];
  const groups = new Map();
  for (const observation of observations) {
    const group = groups.get(observation.provider) || [];
    group.push(observation);
    groups.set(observation.provider, group);
  }
  const batches = [];
  for (const [provider, group] of groups) {
    for (let index = 0; index < group.length; index += 100) {
      // Reuse the schema-v2 envelope; the placeholder never enters the payload.
      const envelope = createCaptureBatches([{ provider }], config, "periodic_scan", options)[0];
      envelope.events = [];
      envelope.conversationUpdates = group.slice(index, index + 100).map(({ conversationId, chatTitle, capturedAt, sourceMetadata }) => ({
        conversationId, chatTitle, capturedAt, sourceMetadata: { ...sourceMetadata }
      }));
      batches.push(envelope);
    }
  }
  return batches;
}

export function createConversationRepairBatches(events, config, provider, conversationId, options = {}) {
  return createCaptureBatches(
    selectConversationCaptures(events, provider, conversationId),
    config,
    "repair_backfill",
    options
  );
}

export function retryDelayMs(attemptCount) {
  const exponent = Math.max(0, Math.min(Number(attemptCount) - 1, 6));
  return Math.min(60 * 60 * 1000, 30 * 1000 * (2 ** exponent));
}

export function isPermanentUploadStatus(status) {
  return [400, 403, 409, 413, 422].includes(Number(status));
}

export function uploadFailureAction(status) {
  const code = Number(status);
  if (code === 401) return "refresh_session";
  if (code === 403) return "block";
  if ([400, 409, 413, 422].includes(code)) return "quarantine";
  return "retry";
}

export function trimUploadQueue(queue) {
  return queue.slice(0, MAX_QUEUE_BATCHES);
}

export const syncLimits = Object.freeze({
  maxEventsPerBatch: MAX_EVENTS_PER_BATCH,
  maxQueueBatches: MAX_QUEUE_BATCHES,
  maxSafeBatchBytes: MAX_SAFE_BATCH_BYTES
});
