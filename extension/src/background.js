import "./core.js";
import {
  createCaptureBatches,
  isPermanentUploadStatus,
  isUuid,
  normalizeIngestionEndpoint,
  retryDelayMs,
  trimUploadQueue,
  uploadFailureAction
} from "./sync-core.js";

const core = globalThis.SharedMemoryCaptureCore;
const extensionApi = globalThis.browser ?? globalThis.chrome;

const DEFAULT_SETTINGS = {
  captureEnabled: true,
  captureAttachments: false,
  captureTemporaryChats: false,
  debugMode: true
};

const DEFAULT_STATS = {
  totalEvents: 0,
  updatedEvents: 0,
  duplicateEvents: 0,
  diagnosticEvents: 0,
  syncedEvents: 0,
  pendingBatches: 0,
  lastCaptureAt: null,
  lastSyncAt: null,
  lastSyncError: null,
  lastError: null
};

const UPLOAD_ALARM = "shared-memory-upload";
const SUPABASE_URL = "https://zwpzmmfpgjaaikacoqas.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_mEtfpCKWHYDKARfWNNO5BA_ouWQWmfN";
const MAX_QUARANTINED_BATCHES = 50;
const CAPTURE_SESSION_ID = crypto.randomUUID();
let uploadInFlight = false;
let captureMutationChain = Promise.resolve();

function operatingSystem() {
  const value = String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || "").toLowerCase();
  if (value.includes("mac")) return "macos";
  if (value.includes("win")) return "windows";
  if (value.includes("android")) return "android";
  if (value.includes("cros")) return "chromeos";
  if (value.includes("linux")) return "linux";
  if (value.includes("iphone") || value.includes("ipad") || value.includes("ios")) return "ios";
  return "unknown";
}

async function technicalDataAllowed() {
  if (!globalThis.browser) return true;
  const permissions = await extensionApi.permissions.getAll();
  return Array.isArray(permissions.data_collection)
    && permissions.data_collection.includes("technicalAndInteraction");
}

async function captureIdentity() {
  const includeTechnicalData = await technicalDataAllowed();
  if (!includeTechnicalData) {
    return {
      deviceId: "device:technical-data-withheld",
      captureSessionId: "session:technical-data-withheld",
      adapterVersion: extensionApi.runtime.getManifest().version,
      os: "unknown",
      appVersion: null
    };
  }
  const local = await extensionApi.storage.local.get("captureDeviceId");
  const deviceId = local.captureDeviceId || `device:${crypto.randomUUID()}`;
  if (!local.captureDeviceId) await extensionApi.storage.local.set({ captureDeviceId: deviceId });
  return {
    deviceId,
    captureSessionId: `session:${CAPTURE_SESSION_ID}`,
    adapterVersion: extensionApi.runtime.getManifest().version,
    os: operatingSystem(),
    appVersion: null
  };
}

async function updateActionAlert({ blockedReason = null, quarantinedCount = 0 } = {}) {
  const needsAttention = Boolean(blockedReason || quarantinedCount);
  await extensionApi.action.setBadgeBackgroundColor({ color: needsAttention ? "#B42318" : "#2E7D32" });
  await extensionApi.action.setBadgeText({ text: needsAttention ? "!" : "" });
  await extensionApi.action.setTitle({
    title: needsAttention
      ? `Shared Memory needs attention${quarantinedCount ? ` · ${quarantinedCount} quarantined batch${quarantinedCount === 1 ? "" : "es"}` : ""}`
      : "Sherry Capture"
  });
}

extensionApi.runtime.onInstalled.addListener(async () => {
  const existing = await extensionApi.storage.sync.get(DEFAULT_SETTINGS);
  await extensionApi.storage.sync.set({ ...DEFAULT_SETTINGS, ...existing });
  const { captureStats } = await extensionApi.storage.local.get("captureStats");
  if (!captureStats) await extensionApi.storage.local.set({ captureStats: DEFAULT_STATS });
});

async function appendDiagnostic(event) {
  const { diagnosticEvents = [], captureStats = DEFAULT_STATS } = await extensionApi.storage.local.get([
    "diagnosticEvents",
    "captureStats"
  ]);
  diagnosticEvents.push(event);
  const trimmed = diagnosticEvents.slice(-500);
  await extensionApi.storage.local.set({
    diagnosticEvents: trimmed,
    captureStats: {
      ...captureStats,
      diagnosticEvents: captureStats.diagnosticEvents + 1,
      lastError: event.status === "error" ? event.detail?.message || event.stage : captureStats.lastError
    }
  });
}

async function storeBatch(events, reason) {
  const { capturedEvents = [], captureStats = DEFAULT_STATS } = await extensionApi.storage.local.get([
    "capturedEvents",
    "captureStats"
  ]);
  const sanitizedStoredEvents = capturedEvents.filter(
    (event) => !core.isTransientAssistantStatus(event.role, event.text)
  );
  const sanitizedIncomingEvents = events.filter(
    (event) => !core.isTransientAssistantStatus(event.role, event.text)
  );
  const removedTransient = (capturedEvents.length - sanitizedStoredEvents.length)
    + (events.length - sanitizedIncomingEvents.length);
  const reconciliation = core.reconcileProvisionalAliases(
    sanitizedStoredEvents,
    sanitizedIncomingEvents
  );
  const exactDuplicates = core.filterExactFallbackDuplicates(
    reconciliation.events,
    sanitizedIncomingEvents
  );
  const uniqueIncomingEvents = core.disambiguateFallbackCollisions(reconciliation.events, exactDuplicates.events);
  const identityReconciliation = core.reconcileFallbackEventIdentities(
    reconciliation.events,
    uniqueIncomingEvents
  );
  const byId = new Map(identityReconciliation.events.map((event) => [event.eventId, event]));
  let added = 0;
  let updated = identityReconciliation.migrations.length;
  let duplicates = reconciliation.merged + exactDuplicates.duplicates;
  const migratedEventIds = new Set(identityReconciliation.migrations.map((item) => item.toEventId));
  const changedEvents = uniqueIncomingEvents.filter((event) => migratedEventIds.has(event.eventId));

  for (const event of uniqueIncomingEvents) {
    const existing = byId.get(event.eventId);
    if (!existing) {
      byId.set(event.eventId, event);
      added += 1;
      changedEvents.push(event);
    } else if (existing.contentHash !== event.contentHash) {
      byId.set(event.eventId, { ...event, firstCapturedAt: existing.firstCapturedAt || existing.capturedAt });
      updated += 1;
      changedEvents.push(event);
    } else {
      duplicates += 1;
    }
  }

  const storedEvents = [...byId.values()]
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
    .slice(-2000);
  const nextStats = {
    ...captureStats,
    totalEvents: storedEvents.length,
    updatedEvents: captureStats.updatedEvents + updated,
    duplicateEvents: captureStats.duplicateEvents + duplicates,
    lastCaptureAt: changedEvents.at(-1)?.capturedAt || captureStats.lastCaptureAt
  };

  await extensionApi.storage.local.set({ capturedEvents: storedEvents, captureStats: nextStats });
  await appendDiagnostic({
    provider: sanitizedIncomingEvents[0]?.provider || "chatgpt",
    stage: "local_store",
    status: "ok",
    at: new Date().toISOString(),
    detail: {
      reason,
      received: events.length,
      accepted: sanitizedIncomingEvents.length,
      removedTransient,
      aliasesReconciled: reconciliation.aliases,
      fallbackIdentitiesReconciled: identityReconciliation.migrations,
      positionalRecapturesIgnored: exactDuplicates.duplicates,
      migrated: reconciliation.migrated,
      added,
      updated,
      duplicates
    }
  });

  await enqueueUploads(changedEvents, reason);

  return { added, updated, duplicates, removedTransient, total: storedEvents.length };
}

function safeIngestionStatus(config, queue, stats, quarantined = []) {
  const latestQuarantine = quarantined.at(-1);
  return {
    enabled: Boolean(config?.enabled),
    endpoint: config?.endpoint || "",
    workspaceId: config?.workspaceId || "",
    hasAccessToken: Boolean(config?.accessToken),
    blockedReason: config?.blockedReason || null,
    pendingBatches: queue.length,
    quarantinedBatches: quarantined.length,
    needsAttention: Boolean(config?.blockedReason || quarantined.length),
    latestQuarantine: latestQuarantine ? {
      batchId: latestQuarantine.batchId,
      provider: latestQuarantine.provider,
      status: latestQuarantine.status,
      message: latestQuarantine.message,
      details: latestQuarantine.details,
      quarantinedAt: latestQuarantine.quarantinedAt
    } : null,
    lastSyncAt: stats?.lastSyncAt || null,
    lastSyncError: stats?.lastSyncError || null
  };
}

async function refreshSupabaseSession(config) {
  if (!config?.refreshToken) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: config.refreshToken })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) return null;
  return {
    ...config,
    accessToken: body.access_token,
    refreshToken: body.refresh_token || config.refreshToken,
    expiresAt: body.expires_at || null,
    blockedReason: null,
    updatedAt: new Date().toISOString()
  };
}

async function uploadBatch(config, item) {
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.accessToken}`,
      "content-type": "application/json",
      "idempotency-key": item.payload.batchId
    },
    body: JSON.stringify(item.payload)
  });
  return { response, responseBody: await response.json().catch(() => null) };
}

async function scheduleUpload(nextAttemptAt = Date.now()) {
  const delayInMinutes = Math.max(0.5, (nextAttemptAt - Date.now()) / 60_000);
  await extensionApi.alarms.create(UPLOAD_ALARM, { delayInMinutes });
}

async function enqueueUploads(events, reason) {
  if (!events.length) return;
  const local = await extensionApi.storage.local.get(["ingestionConfig", "uploadQueue", "captureStats"]);
  const config = local.ingestionConfig;
  if (!config?.enabled || !config.accessToken || !config.endpoint || !isUuid(config.workspaceId)) return;
  const identity = await captureIdentity();
  const queue = local.uploadQueue || [];
  const payloads = createCaptureBatches(events, { ...config, ...identity }, reason);
  const now = Date.now();
  for (const payload of payloads) {
    queue.push({ payload, attemptCount: 0, nextAttemptAt: now, lastError: null });
  }
  const overflow = Math.max(0, queue.length - 100);
  const trimmed = trimUploadQueue(queue);
  await extensionApi.storage.local.set({
    uploadQueue: trimmed,
    captureStats: { ...DEFAULT_STATS, ...local.captureStats, pendingBatches: trimmed.length }
  });
  if (overflow) {
    await appendDiagnostic({
      provider: events[0]?.provider || "chatgpt",
      stage: "cloud_sync_queue",
      status: "warning",
      at: new Date().toISOString(),
      detail: {
        message: `${overflow} new batch${overflow === 1 ? " was" : "es were"} not queued because the local queue is full. The events remain in local capture history for backfill.`,
        capacity: 100
      }
    });
  }
  await scheduleUpload(now);
  void processUploadQueue();
}

async function processUploadQueue() {
  if (uploadInFlight) return;
  uploadInFlight = true;
  try {
    let processed = 0;
    while (processed < 5) {
      const local = await extensionApi.storage.local.get(["ingestionConfig", "uploadQueue", "captureStats", "quarantinedUploadBatches"]);
      let config = local.ingestionConfig;
      const queue = local.uploadQueue || [];
      const quarantined = local.quarantinedUploadBatches || [];
      const stats = { ...DEFAULT_STATS, ...local.captureStats };
      if (!config?.enabled || config.blockedReason || !config.accessToken || !queue.length) return;

      const item = queue[0];
      if (item.nextAttemptAt > Date.now()) {
        await scheduleUpload(item.nextAttemptAt);
        return;
      }

      let response;
      let responseBody;
      try {
        ({ response, responseBody } = await uploadBatch(config, item));
        if (response.status === 401) {
          const refreshed = await refreshSupabaseSession(config);
          if (refreshed) {
            config = refreshed;
            await extensionApi.storage.local.set({ ingestionConfig: config });
            ({ response, responseBody } = await uploadBatch(config, item));
          }
        }
      } catch (error) {
        response = null;
        responseBody = { error: { message: error.message } };
      }

      if (response?.ok) {
        queue.shift();
        const accepted = Number(responseBody?.result?.inserted || 0) + Number(responseBody?.result?.updated || 0);
        await extensionApi.storage.local.set({
          uploadQueue: queue,
          captureStats: {
            ...stats,
            syncedEvents: stats.syncedEvents + accepted,
            pendingBatches: queue.length,
            lastSyncAt: new Date().toISOString(),
            lastSyncError: quarantined.length ? stats.lastSyncError : null
          }
        });
        await updateActionAlert({ blockedReason: config.blockedReason, quarantinedCount: quarantined.length });
        await appendDiagnostic({
          provider: item.payload.provider,
          stage: "cloud_sync",
          status: "ok",
          at: new Date().toISOString(),
          detail: {
            batchId: item.payload.batchId,
            received: responseBody?.result?.received,
            inserted: responseBody?.result?.inserted,
            updated: responseBody?.result?.updated,
            duplicates: responseBody?.result?.duplicates,
            redactions: responseBody?.redactions?.total || 0
          }
        });
        processed += 1;
        continue;
      }

      const attemptCount = item.attemptCount + 1;
      const status = response?.status || 0;
      const message = responseBody?.error?.message || `Upload failed${status ? ` (${status})` : ""}`;
      const details = responseBody?.error?.details || null;
      const action = uploadFailureAction(status);
      const permanent = isPermanentUploadStatus(status);
      const nextAttemptAt = Date.now() + retryDelayMs(attemptCount);
      if (action === "quarantine") {
        queue.shift();
        quarantined.push({
          batchId: item.payload.batchId,
          provider: item.payload.provider,
          status,
          message,
          details,
          eventCount: item.payload.events.length,
          quarantinedAt: new Date().toISOString()
        });
        const trimmedQuarantine = quarantined.slice(-MAX_QUARANTINED_BATCHES);
        await extensionApi.storage.local.set({
          ingestionConfig: config,
          uploadQueue: queue,
          quarantinedUploadBatches: trimmedQuarantine,
          captureStats: { ...stats, pendingBatches: queue.length, lastSyncError: message }
        });
        await updateActionAlert({ blockedReason: config.blockedReason, quarantinedCount: trimmedQuarantine.length });
        await appendDiagnostic({
          provider: item.payload.provider,
          stage: "cloud_sync_quarantine",
          status: "error",
          at: new Date().toISOString(),
          detail: { batchId: item.payload.batchId, status, attemptCount, message, details, continuingWithLaterBatches: true }
        });
        processed += 1;
        continue;
      }
      queue[0] = { ...item, attemptCount, nextAttemptAt, lastError: message };
      const blockedReason = action === "block"
        ? message
        : action === "refresh_session"
          ? "Your cloud session expired. Sign in once to reconnect; captured messages remain safe locally."
          : config.blockedReason;
      const nextConfig = { ...config, blockedReason };
      await extensionApi.storage.local.set({
        ingestionConfig: nextConfig,
        uploadQueue: queue,
        captureStats: { ...stats, pendingBatches: queue.length, lastSyncError: message }
      });
      await updateActionAlert({ blockedReason, quarantinedCount: quarantined.length });
      await appendDiagnostic({
        provider: item.payload.provider,
        stage: "cloud_sync",
        status: permanent ? "error" : "warning",
        at: new Date().toISOString(),
        detail: { batchId: item.payload.batchId, status, attemptCount, permanent, action, message, details }
      });
      if (action === "retry") await scheduleUpload(nextAttemptAt);
      return;
    }
  } finally {
    uploadInFlight = false;
  }
}

async function updateIngestionConfig(payload) {
  const endpoint = normalizeIngestionEndpoint(payload?.endpoint);
  if (!isUuid(payload?.workspaceId)) throw new Error("A valid workspace ID is required.");
  const local = await extensionApi.storage.local.get(["capturedEvents", "uploadQueue", "captureStats", "ingestionConfig", "quarantinedUploadBatches"]);
  const accessToken = typeof payload?.accessToken === "string" && payload.accessToken.trim()
    ? payload.accessToken.trim()
    : local.ingestionConfig?.accessToken || "";
  if (accessToken.length < 20) {
    throw new Error("A valid Supabase session access token is required.");
  }
  const config = {
    enabled: true,
    endpoint,
    workspaceId: payload.workspaceId,
    accessToken,
    refreshToken: typeof payload?.refreshToken === "string" && payload.refreshToken.trim()
      ? payload.refreshToken.trim()
      : local.ingestionConfig?.refreshToken || "",
    expiresAt: payload?.expiresAt || local.ingestionConfig?.expiresAt || null,
    blockedReason: null,
    updatedAt: new Date().toISOString()
  };
  let queue = local.uploadQueue || [];
  if (payload.uploadExisting && (local.capturedEvents || []).length) {
    const identity = await captureIdentity();
    const backfill = createCaptureBatches(local.capturedEvents, { ...config, ...identity }, "initial_backfill")
      .map((batch) => ({ payload: batch, attemptCount: 0, nextAttemptAt: Date.now(), lastError: null }));
    const combined = [...queue, ...backfill];
    queue = trimUploadQueue(combined);
  }
  await extensionApi.storage.local.set({
    ingestionConfig: config,
    uploadQueue: queue,
    captureStats: { ...DEFAULT_STATS, ...local.captureStats, pendingBatches: queue.length, lastSyncError: null }
  });
  await updateActionAlert({ quarantinedCount: (local.quarantinedUploadBatches || []).length });
  await scheduleUpload();
  void processUploadQueue();
  return safeIngestionStatus(config, queue, local.captureStats, local.quarantinedUploadBatches || []);
}

async function reuploadExistingCaptures() {
  const local = await extensionApi.storage.local.get(["capturedEvents", "uploadQueue", "captureStats", "ingestionConfig", "quarantinedUploadBatches"]);
  const config = local.ingestionConfig;
  if (!config?.enabled || !config.accessToken) throw new Error("Connect cloud sync before re-uploading captures.");
  const identity = await captureIdentity();
  const backfill = createCaptureBatches(local.capturedEvents || [], { ...config, ...identity }, "repair_backfill")
    .map((batch) => ({ payload: batch, attemptCount: 0, nextAttemptAt: Date.now(), lastError: null }));
  const queue = trimUploadQueue([...(local.uploadQueue || []), ...backfill]);
  await extensionApi.storage.local.set({
    uploadQueue: queue,
    captureStats: { ...DEFAULT_STATS, ...local.captureStats, pendingBatches: queue.length, lastSyncError: null }
  });
  await scheduleUpload();
  void processUploadQueue();
  return safeIngestionStatus(config, queue, local.captureStats, local.quarantinedUploadBatches || []);
}

async function rekeyConversation(fromConversationId, toConversationId, sourceUrl) {
  const { capturedEvents = [], captureStats = DEFAULT_STATS } = await extensionApi.storage.local.get([
    "capturedEvents",
    "captureStats"
  ]);
  const sanitizedEvents = capturedEvents.filter(
    (event) => !core.isTransientAssistantStatus(event.role, event.text)
  );
  const removedTransient = capturedEvents.length - sanitizedEvents.length;
  const result = core.rekeyCapturedEvents(
    sanitizedEvents,
    fromConversationId,
    toConversationId,
    sourceUrl
  );
  const storedEvents = result.events
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
    .slice(-2000);

  await extensionApi.storage.local.set({
    capturedEvents: storedEvents,
    captureStats: {
      ...captureStats,
      totalEvents: storedEvents.length,
      duplicateEvents: captureStats.duplicateEvents + result.merged
    }
  });
  await appendDiagnostic({
    provider: result.events.find((event) => event.conversationId === toConversationId)?.provider || "chatgpt",
    stage: "conversation_rekey",
    status: "ok",
    at: new Date().toISOString(),
    detail: {
      fromConversationId,
      toConversationId,
      migrated: result.migrated,
      merged: result.merged,
      removedTransient
    }
  });

  return {
    migrated: result.migrated,
    merged: result.merged,
    removedTransient,
    total: storedEvents.length
  };
}

async function extensionStatusPayload() {
  const [local, settings] = await Promise.all([
    extensionApi.storage.local.get(["captureStats", "capturedEvents", "diagnosticEvents", "ingestionConfig", "uploadQueue", "quarantinedUploadBatches"]),
    extensionApi.storage.sync.get(DEFAULT_SETTINGS)
  ]);
  const { ingestionConfig, uploadQueue = [], quarantinedUploadBatches = [], ...safeLocal } = local;
  return {
    ok: true,
    version: extensionApi.runtime.getManifest().version,
    ...safeLocal,
    settings,
    ingestion: safeIngestionStatus(ingestionConfig, uploadQueue, local.captureStats, quarantinedUploadBatches)
  };
}

async function updateCaptureSettings(payload = {}) {
  const allowed = Object.fromEntries(Object.entries(payload).filter(([key, value]) => key in DEFAULT_SETTINGS && typeof value === "boolean"));
  await extensionApi.storage.sync.set(allowed);
  const tabs = await extensionApi.tabs.query({
    url: [
      "https://chatgpt.com/*",
      "https://chat.openai.com/*",
      "https://claude.ai/*",
      "https://gemini.google.com/*"
    ]
  });
  await Promise.allSettled(tabs.map((tab) => extensionApi.tabs.sendMessage(tab.id, { type: "SETTINGS_CHANGED" })));
  return { ok: true };
}

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CAPTURE_BATCH") {
    captureMutationChain = captureMutationChain
      .catch(() => undefined)
      .then(() => storeBatch(message.payload?.events ?? [], message.payload?.reason ?? "unknown"));
    captureMutationChain
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "DIAGNOSTIC_EVENT") {
    appendDiagnostic(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "REKEY_CONVERSATION") {
    const payload = message.payload ?? {};
    captureMutationChain = captureMutationChain
      .catch(() => undefined)
      .then(() => rekeyConversation(
        payload.fromConversationId,
        payload.toConversationId,
        payload.sourceUrl
      ));
    captureMutationChain
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_STATUS") {
    extensionStatusPayload().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "UPDATE_INGESTION_CONFIG") {
    updateIngestionConfig(message.payload)
      .then((ingestion) => sendResponse({ ok: true, ingestion }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CLEAR_INGESTION_CONFIG") {
    extensionApi.storage.local.get("captureStats").then(async ({ captureStats }) => {
      await extensionApi.storage.local.remove(["ingestionConfig", "uploadQueue", "quarantinedUploadBatches"]);
      await extensionApi.storage.local.set({
        captureStats: { ...DEFAULT_STATS, ...captureStats, pendingBatches: 0, lastSyncError: null }
      });
      await updateActionAlert();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "RETRY_UPLOADS") {
    extensionApi.storage.local.get(["ingestionConfig", "uploadQueue"]).then(async ({ ingestionConfig, uploadQueue = [] }) => {
      const queue = uploadQueue.map((item) => ({ ...item, nextAttemptAt: Date.now() }));
      await extensionApi.storage.local.set({
        ingestionConfig: ingestionConfig ? { ...ingestionConfig, blockedReason: null } : ingestionConfig,
        uploadQueue: queue
      });
      void processUploadQueue();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "REUPLOAD_EXISTING") {
    reuploadExistingCaptures()
      .then((ingestion) => sendResponse({ ok: true, ingestion }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "UPDATE_SETTINGS") {
    updateCaptureSettings(message.payload).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

const EXTERNAL_CONTROL_ORIGINS = new Set([
  "https://shared-memory-ingestion.mufaddal-m25.workers.dev",
  "http://localhost",
  "http://127.0.0.1"
]);

function externalControlAllowed(sender) {
  try {
    return EXTERNAL_CONTROL_ORIGINS.has(new URL(sender?.url || "").origin);
  } catch {
    return false;
  }
}

extensionApi.runtime.onMessageExternal?.addListener((message, sender, sendResponse) => {
  if (!externalControlAllowed(sender)) {
    sendResponse({ ok: false, error: "This page is not allowed to control the extension." });
    return false;
  }
  if (message?.type === "GET_STATUS") {
    extensionStatusPayload().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "UPDATE_SETTINGS") {
    updateCaptureSettings(message.payload).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "RETRY_UPLOADS") {
    extensionApi.storage.local.get(["ingestionConfig", "uploadQueue"]).then(async ({ ingestionConfig, uploadQueue = [] }) => {
      await extensionApi.storage.local.set({
        ingestionConfig: ingestionConfig ? { ...ingestionConfig, blockedReason: null } : ingestionConfig,
        uploadQueue: uploadQueue.map((item) => ({ ...item, nextAttemptAt: Date.now() }))
      });
      void processUploadQueue();
      sendResponse({ ok: true });
    }).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "REUPLOAD_EXISTING") {
    reuploadExistingCaptures().then((ingestion) => sendResponse({ ok: true, ingestion })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "OPEN_DIAGNOSTICS") {
    extensionStatusPayload().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  sendResponse({ ok: false, error: "Unsupported extension control request." });
  return false;
});

extensionApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPLOAD_ALARM) void processUploadQueue();
});

extensionApi.runtime.onStartup.addListener(() => void processUploadQueue());

async function reconnectOpenSherryTabs() {
  if (!extensionApi.scripting?.executeScript) return;
  const tabs = await extensionApi.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url?.startsWith("https://shared-memory-ingestion.mufaddal-m25.workers.dev/")) continue;
    try {
      await extensionApi.scripting.executeScript({ target: { tabId: tab.id }, files: ["/src/sherry-bridge.js"] });
    } catch (error) {
      console.warn("Sherry page bridge could not be restored", error);
    }
  }
}

extensionApi.runtime.onInstalled.addListener(() => void reconnectOpenSherryTabs().catch((error) => console.warn("Sherry page reconnect failed", error)));
extensionApi.runtime.onStartup.addListener(() => void reconnectOpenSherryTabs().catch((error) => console.warn("Sherry page reconnect failed", error)));
extensionApi.permissions?.onAdded?.addListener(() => void reconnectOpenSherryTabs().catch((error) => console.warn("Sherry page reconnect failed", error)));

extensionApi.storage.local.get(["ingestionConfig", "quarantinedUploadBatches"]).then(({ ingestionConfig, quarantinedUploadBatches = [] }) => {
  void updateActionAlert({
    blockedReason: ingestionConfig?.blockedReason,
    quarantinedCount: quarantinedUploadBatches.length
  });
});
