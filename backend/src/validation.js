const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-z0-9:_-]{8,128}$/i;
const EVENT_ID_PATTERN = /^evt_[a-z0-9:_-]{4,120}$/i;
const SUPPORTED_PRODUCTS = new Set(["chatgpt", "codex", "claude", "claude_code", "gemini", "antigravity"]);
const SUPPORTED_PROVIDER_FAMILIES = new Set(["openai", "anthropic", "google"]);
const SUPPORTED_SURFACES = new Set(["web", "desktop", "cli", "ide", "android"]);
const SUPPORTED_ADAPTER_TYPES = new Set(["browser_dom", "structured_hook", "accessibility", "share", "historical_import"]);
const SUPPORTED_OPERATING_SYSTEMS = new Set(["macos", "windows", "linux", "android", "chromeos", "ios", "unknown"]);
const SUPPORTED_COVERAGE_STATES = new Set(["complete_observed_range", "partial", "gap_detected", "awaiting_backfill"]);
const SUPPORTED_CAPTURE_REASONS = new Set([
  "mutation", "initial_scan", "manual", "reload_recovery", "opened_chat_backfill",
  "initial_backfill", "repair_backfill", "hook", "accessibility", "share", "historical_import"
]);
const SUPPORTED_ROLES = new Set(["user", "assistant", "system", "tool", "unknown"]);
const PROVIDER_HOSTS = {
  chatgpt: new Set(["chatgpt.com", "chat.openai.com"]),
  claude: new Set(["claude.ai"]),
  gemini: new Set(["gemini.google.com"])
};
const PRODUCT_FAMILIES = Object.freeze({
  chatgpt: "openai",
  codex: "openai",
  claude: "anthropic",
  claude_code: "anthropic",
  gemini: "google",
  antigravity: "google"
});

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function isAllowedUrl(value, provider, enforceProviderHost = false) {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    return !enforceProviderHost || PROVIDER_HOSTS[provider]?.has(url.hostname);
  } catch {
    return false;
  }
}

function pushError(errors, path, message) {
  if (errors.length < 25) errors.push({ path, message });
}

function optionalBoundedString(value, maximum = 512) {
  return value === null || value === undefined
    || (typeof value === "string" && value.length <= maximum);
}

function validateEvent(event, index, capture, errors) {
  const path = `events[${index}]`;
  if (!isObject(event)) {
    pushError(errors, path, "must be an object");
    return null;
  }

  if (!EVENT_ID_PATTERN.test(event.eventId ?? "")) {
    pushError(errors, `${path}.eventId`, "must be a stable evt_ identifier");
  }
  if (typeof event.conversationId !== "string" || !event.conversationId.trim() || event.conversationId.length > 512) {
    pushError(errors, `${path}.conversationId`, "must be a non-empty string of at most 512 characters");
  }
  if (event.providerMessageId !== null && event.providerMessageId !== undefined
    && (typeof event.providerMessageId !== "string" || event.providerMessageId.length > 512)) {
    pushError(errors, `${path}.providerMessageId`, "must be null or a string of at most 512 characters");
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 0 || event.sequence > 1_000_000) {
    pushError(errors, `${path}.sequence`, "must be an integer between 0 and 1,000,000");
  }
  if (!SUPPORTED_ROLES.has(event.role)) {
    pushError(errors, `${path}.role`, "must be user, assistant, system, tool, or unknown");
  }
  if (typeof event.text !== "string" || !event.text.trim() || event.text.length > 250_000) {
    pushError(errors, `${path}.text`, "must be non-empty and at most 250,000 characters");
  }
  if (!HASH_PATTERN.test(event.contentHash ?? "")) {
    pushError(errors, `${path}.contentHash`, "must be an 8-128 character content hash");
  }
  if (event.provider !== undefined && event.provider !== capture.product) {
    pushError(errors, `${path}.provider`, `must match the batch product ${capture.product}`);
  }
  const sourceUrlRequired = capture.schemaVersion === 1 || capture.surface === "web";
  if (sourceUrlRequired && !isAllowedUrl(event.sourceUrl, capture.product, true)) {
    pushError(errors, `${path}.sourceUrl`, `must be an HTTPS ${capture.product} conversation URL`);
  } else if (!sourceUrlRequired && event.sourceUrl != null && !isAllowedUrl(event.sourceUrl, capture.product, false)) {
    pushError(errors, `${path}.sourceUrl`, "must be null or an HTTPS URL");
  }
  if (!optionalBoundedString(event.sourceLocator, 1024)) {
    pushError(errors, `${path}.sourceLocator`, "must be null or a string of at most 1,024 characters");
  }
  if (!event.sourceUrl && (typeof event.sourceLocator !== "string" || !event.sourceLocator.trim())) {
    pushError(errors, `${path}.sourceLocator`, "is required when sourceUrl is unavailable");
  }
  if (typeof event.chatTitle !== "string" || !event.chatTitle.trim() || event.chatTitle.length > 1000) {
    pushError(errors, `${path}.chatTitle`, "must be non-empty and at most 1,000 characters");
  }
  if (event.messageTimestamp !== null && event.messageTimestamp !== undefined && !isIsoTimestamp(event.messageTimestamp)) {
    pushError(errors, `${path}.messageTimestamp`, "must be null or an ISO timestamp");
  }
  if (!isIsoTimestamp(event.capturedAt)) {
    pushError(errors, `${path}.capturedAt`, "must be an ISO timestamp");
  }
  if (!Array.isArray(event.links) || event.links.length > 50
    || event.links.some((link) => !isAllowedUrl(link, capture.product, false))) {
    pushError(errors, `${path}.links`, "must contain at most 50 HTTPS URLs");
  }
  if (!Array.isArray(event.attachments) || event.attachments.length > 25
    || event.attachments.some((attachment) => !isObject(attachment))) {
    pushError(errors, `${path}.attachments`, "must contain at most 25 metadata objects");
  }

  return {
    eventId: event.eventId,
    provider: capture.product,
    conversationId: event.conversationId.trim(),
    providerMessageId: event.providerMessageId?.trim() || null,
    sequence: event.sequence,
    role: event.role,
    text: event.text,
    contentHash: event.contentHash,
    sourceUrl: event.sourceUrl || null,
    sourceLocator: event.sourceLocator?.trim() || null,
    chatTitle: event.chatTitle.trim(),
    messageTimestamp: event.messageTimestamp || null,
    capturedAt: event.capturedAt,
    links: [...new Set(event.links)],
    attachments: event.attachments
  };
}

export function validateCaptureBatch(payload) {
  const errors = [];
  if (!isObject(payload)) return { ok: false, errors: [{ path: "$", message: "must be a JSON object" }] };

  if (![1, 2].includes(payload.schemaVersion)) pushError(errors, "schemaVersion", "must equal 1 or 2");
  if (!UUID_PATTERN.test(payload.batchId ?? "")) pushError(errors, "batchId", "must be a UUID");
  if (!UUID_PATTERN.test(payload.workspaceId ?? "")) pushError(errors, "workspaceId", "must be a UUID");
  if (!SUPPORTED_PRODUCTS.has(payload.provider)) {
    pushError(errors, "provider", "must be a supported provider product");
  }
  if (typeof payload.reason !== "string" || !payload.reason.trim() || payload.reason.length > 100) {
    pushError(errors, "reason", "must be non-empty and at most 100 characters");
  }
  if (!isIsoTimestamp(payload.clientCreatedAt)) {
    pushError(errors, "clientCreatedAt", "must be an ISO timestamp");
  }
  if (!Array.isArray(payload.events) || payload.events.length < 1 || payload.events.length > 100) {
    pushError(errors, "events", "must contain between 1 and 100 events");
  }

  const product = SUPPORTED_PRODUCTS.has(payload.provider) ? payload.provider : "chatgpt";
  const schemaVersion = payload.schemaVersion === 2 ? 2 : 1;
  const capture = {
    schemaVersion,
    product,
    providerFamily: schemaVersion === 2 ? payload.providerFamily : PRODUCT_FAMILIES[product],
    surface: schemaVersion === 2 ? payload.surface : "web"
  };

  if (schemaVersion === 2) {
    if (!SUPPORTED_PROVIDER_FAMILIES.has(payload.providerFamily)) {
      pushError(errors, "providerFamily", "must be openai, anthropic, or google");
    } else if (PRODUCT_FAMILIES[product] !== payload.providerFamily) {
      pushError(errors, "providerFamily", `does not match product ${product}`);
    }
    if (payload.product !== product) pushError(errors, "product", "must match provider");
    if (!SUPPORTED_SURFACES.has(payload.surface)) {
      pushError(errors, "surface", "must be web, desktop, cli, ide, or android");
    }
    if (!SUPPORTED_CAPTURE_REASONS.has(payload.reason)) {
      pushError(errors, "reason", "is not supported by Capture API v2");
    }

    if (!isObject(payload.captureClient)) {
      pushError(errors, "captureClient", "must be an object");
    } else {
      const client = payload.captureClient;
      if (!SUPPORTED_ADAPTER_TYPES.has(client.type)) pushError(errors, "captureClient.type", "is not a supported adapter type");
      if (typeof client.adapterVersion !== "string" || !client.adapterVersion.trim() || client.adapterVersion.length > 100) {
        pushError(errors, "captureClient.adapterVersion", "must be a non-empty string of at most 100 characters");
      }
      if (typeof client.deviceId !== "string" || client.deviceId.trim().length < 8 || client.deviceId.length > 200) {
        pushError(errors, "captureClient.deviceId", "must be a pseudonymous identifier between 8 and 200 characters");
      }
      if (!SUPPORTED_OPERATING_SYSTEMS.has(client.os)) pushError(errors, "captureClient.os", "is not a supported operating system value");
      if (!optionalBoundedString(client.appVersion, 200)) pushError(errors, "captureClient.appVersion", "must be null or at most 200 characters");
      if (typeof client.captureSessionId !== "string" || client.captureSessionId.trim().length < 8 || client.captureSessionId.length > 200) {
        pushError(errors, "captureClient.captureSessionId", "must be between 8 and 200 characters");
      }
    }

    if (!isObject(payload.coverage)) {
      pushError(errors, "coverage", "must be an object");
    } else {
      if (!SUPPORTED_COVERAGE_STATES.has(payload.coverage.state)) pushError(errors, "coverage.state", "is not a supported coverage state");
      if (typeof payload.coverage.gapBefore !== "boolean") pushError(errors, "coverage.gapBefore", "must be true or false");
      if (typeof payload.coverage.backfillAvailable !== "boolean") pushError(errors, "coverage.backfillAvailable", "must be true or false");
    }
  }

  const events = Array.isArray(payload.events)
    ? payload.events.slice(0, 100).map((event, index) => validateEvent(event, index, capture, errors)).filter(Boolean)
    : [];

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion,
      batchId: payload.batchId,
      workspaceId: payload.workspaceId,
      provider: product,
      providerFamily: capture.providerFamily,
      product,
      surface: capture.surface,
      reason: payload.reason.trim(),
      clientCreatedAt: payload.clientCreatedAt,
      captureClient: schemaVersion === 2 ? {
        type: payload.captureClient.type,
        adapterVersion: payload.captureClient.adapterVersion.trim(),
        deviceId: payload.captureClient.deviceId.trim(),
        os: payload.captureClient.os,
        appVersion: payload.captureClient.appVersion?.trim() || null,
        captureSessionId: payload.captureClient.captureSessionId.trim()
      } : null,
      coverage: schemaVersion === 2 ? {
        state: payload.coverage.state,
        gapBefore: payload.coverage.gapBefore,
        backfillAvailable: payload.coverage.backfillAvailable
      } : null,
      events
    }
  };
}

export const captureLimits = Object.freeze({ maxEvents: 100, defaultMaxBatchBytes: 524_288 });
export const captureVocabulary = Object.freeze({
  products: [...SUPPORTED_PRODUCTS],
  providerFamilies: [...SUPPORTED_PROVIDER_FAMILIES],
  surfaces: [...SUPPORTED_SURFACES],
  adapterTypes: [...SUPPORTED_ADAPTER_TYPES],
  coverageStates: [...SUPPORTED_COVERAGE_STATES]
});
