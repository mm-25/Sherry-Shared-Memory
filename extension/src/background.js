import "./core.js";
import { uploadReceiptError } from "./upload-receipt.js";
import { restoreOpenTabs, restoreTab } from "./tab-recovery.js";
import {
  createCaptureBatches,
  createConversationMetadataBatches,
  createConversationRepairBatches,
  isPermanentUploadStatus,
  isUuid,
  normalizeIngestionEndpoint,
  retryDelayMs,
  selectConversationCaptures,
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
let localMutationChain = Promise.resolve();

// All read/modify/write operations share this lock. Network requests never hold it.
function mutateLocal(operation) {
  const result = localMutationChain.catch(() => undefined).then(operation);
  localMutationChain = result;
  return result;
}

function boundedQueue(queue) {
  if (queue.length > 100) throw new Error("Sherry's upload waiting list is full. Keep this chat open while earlier uploads finish; capture will retry automatically.");
  return queue;
}

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

extensionApi.runtime.onInstalled.addListener(() => mutateLocal(async () => {
  const existing = await extensionApi.storage.sync.get(DEFAULT_SETTINGS);
  await extensionApi.storage.sync.set({ ...DEFAULT_SETTINGS, ...existing });
  const { captureStats } = await extensionApi.storage.local.get("captureStats");
  if (!captureStats) await extensionApi.storage.local.set({ captureStats: DEFAULT_STATS });
}));

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

async function storeBatch(events, reason, temporaryChat = false, capabilities = {}) {
  if (!(await extensionApi.storage.sync.get(DEFAULT_SETTINGS)).captureEnabled) throw new Error("Capture is disabled. Resume capture before saving new messages.");
  const { capturedEvents = [], captureStats = DEFAULT_STATS, ingestionConfig, uploadQueue = [], provisionalCaptureOwners = {}, sourceConversationReceipts = {}, captureSourceOwners = {} } = await extensionApi.storage.local.get([
    "capturedEvents", "captureStats", "ingestionConfig", "uploadQueue", "provisionalCaptureOwners", "sourceConversationReceipts", "captureSourceOwners"
  ]);
  if (capabilities.connectionScope !== metadataScope(ingestionConfig)) capabilities = {};
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
  // Equal text at another position is a separate turn, not proof of a rescan.
  const uniqueIncomingEvents = core.disambiguateFallbackCollisions(reconciliation.events, sanitizedIncomingEvents);
  const identityReconciliation = core.reconcileFallbackEventIdentities(
    reconciliation.events,
    uniqueIncomingEvents
  );
  const byId = new Map(identityReconciliation.events.map((event) => [event.eventId, event]));
  let added = 0;
  let updated = identityReconciliation.migrations.length;
  let duplicates = reconciliation.merged;
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
      if (event.sourceMetadata?.version === 1 && existing.provider === event.provider
        && existing.conversationId === event.conversationId && existing.role === event.role && existing.text === event.text) {
        // New source evidence may enrich the same stored message even while an
        // older server is unavailable. Preserve the original content/time and
        // link/attachment copies; the current title has its own observation.
        const sourceMetadata = { ...event.sourceMetadata };
        if ((existing.messageTimestamp || null) !== (event.messageTimestamp || null)) {
          sourceMetadata.timestampBasis = existing.messageTimestamp ? "unknown" : "observed";
        }
        if (JSON.stringify(existing.links || []) !== JSON.stringify(event.links || [])) sourceMetadata.linksStatus = "unknown";
        if (JSON.stringify(existing.attachments || []) !== JSON.stringify(event.attachments || [])) sourceMetadata.attachmentsStatus = "unknown";
        byId.set(event.eventId, { ...existing, chatTitle: event.chatTitle || existing.chatTitle, sourceMetadata });
      }
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

  // An unchanged legacy turn can establish newly observed source evidence in a
  // separate immutable batch. This is still the same message and capture time.
  const deliveryEvents = [...changedEvents];
  if (capabilities.sourceMetadataVersion === 1 && ingestionConfig?.enabled) {
    const identity = await captureIdentity();
    for (const event of uniqueIncomingEvents) {
      if (changedEvents.includes(event) || event.sourceMetadata?.version !== 1) continue;
      const key = metadataIdentityKey(ingestionConfig, event.provider, event, identity.deviceId);
      const alreadyQueued = uploadQueue.some(item => item.payload.workspaceId === ingestionConfig.workspaceId
        && item.payload.events?.some(queued => queued.eventId === event.eventId && queued.sourceMetadata?.version === 1
          && queued.sourceMetadata.conversationIdentity === event.sourceMetadata.conversationIdentity));
      if (key && !sourceConversationReceipts[key] && !alreadyQueued) deliveryEvents.push(byId.get(event.eventId));
    }
  }

  // Acknowledge capture only after its local copy AND delivery work are saved.
  // A duplicate rescan must never encounter a saved event with a lost queue entry.
  const queue = [...uploadQueue];
  if (deliveryEvents.length && ingestionConfig?.enabled && ingestionConfig.accessToken
      && ingestionConfig.endpoint && isUuid(ingestionConfig.workspaceId)) {
    const identity = await captureIdentity();
    // New chats can have no permanent URL yet. Keep their first messages locally
    // until REKEY_CONVERSATION can queue them under the real conversation ID.
    // Opted-in temporary chats may never receive a permanent address.
    const canonicalEvents = deliveryEvents.filter((event) => temporaryChat || !core.isProvisionalConversationId(event.conversationId));
    for (const payload of createCaptureBatches(canonicalEvents, { ...ingestionConfig, ...identity }, reason, { capabilities })) {
      queue.push({ payload, attemptCount: 0, nextAttemptAt: Date.now(), lastError: null });
    }
  }
  boundedQueue(queue);
  for (const event of changedEvents) {
    if (core.isProvisionalConversationId(event.conversationId) && !(event.conversationId in provisionalCaptureOwners)) {
      provisionalCaptureOwners[event.conversationId] = ingestionConfig?.enabled
        ? { workspaceId: ingestionConfig.workspaceId, endpoint: ingestionConfig.endpoint } : null;
    }
  }
  if (ingestionConfig?.enabled) {
    for (const event of uniqueIncomingEvents) {
      if (event.sourceMetadata?.version === 1) captureSourceOwners[JSON.stringify([event.provider, event.eventId])] = metadataScope(ingestionConfig);
    }
  }
  const retainedSourceKeys = new Set(storedEvents.map(event => JSON.stringify([event.provider, event.eventId])));
  const retainedProvisionalIds = new Set(storedEvents.map((event) => event.conversationId));
  await extensionApi.storage.local.set({
    capturedEvents: storedEvents,
    uploadQueue: queue,
    provisionalCaptureOwners: Object.fromEntries(Object.entries(provisionalCaptureOwners).filter(([id]) => retainedProvisionalIds.has(id))),
    captureSourceOwners: Object.fromEntries(Object.entries(captureSourceOwners).filter(([key]) => retainedSourceKeys.has(key))),
    captureStats: { ...nextStats, pendingBatches: queue.length }
  });
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
      migrated: reconciliation.migrated,
      added,
      updated,
      duplicates
    }
  });

  await scheduleUpload();
  void processUploadQueue();

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
    signal: AbortSignal.timeout(20_000),
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

async function sourceCapabilities(config) {
  if (!config?.enabled || !config.endpoint) return {};
  try {
    const endpoint = new URL(config.endpoint);
    endpoint.pathname = "/health";
    const response = await fetch(endpoint.toString(), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return {};
    const body = await response.json();
    return { sourceMetadataVersion: body?.sourceMetadataVersion, conversationUpdatesVersion: body?.conversationUpdatesVersion, connectionScope: metadataScope(config) };
  } catch { return {}; }
}

async function mutateWithSourceCapabilities(operation, configHint = null) {
  const config = configHint || (await extensionApi.storage.local.get("ingestionConfig")).ingestionConfig;
  const capabilities = await sourceCapabilities(config);
  return mutateLocal(() => operation(capabilities));
}

function sourceBatchOptions(config, capabilities) {
  return { capabilities: capabilities.connectionScope === metadataScope(config) ? capabilities : {} };
}

function metadataScope(config) {
  return JSON.stringify([config?.workspaceId, config?.endpoint]);
}

function metadataIdentityKey(config, provider, observation, deviceId) {
  const kind = observation.sourceMetadata?.conversationIdentity;
  if (!["provider", "local"].includes(kind)) return null;
  return JSON.stringify([metadataScope(config), provider, observation.conversationId, kind, kind === "local" ? deviceId : null]);
}

function sameTitle(left, right) {
  return left?.chatTitle === right?.chatTitle && left?.sourceMetadata?.titleBasis === right?.sourceMetadata?.titleBasis;
}

function titleObservationCovered(known, candidate) {
  return sameTitle(known, candidate) && Date.parse(known.capturedAt) >= Date.parse(candidate.capturedAt);
}

async function storeConversationMetadata(observation) {
  const settings = await extensionApi.storage.sync.get(DEFAULT_SETTINGS);
  if (!settings.captureEnabled) throw new Error("Capture is disabled. The title will be retried after capture resumes.");
  const local = await extensionApi.storage.local.get(["ingestionConfig", "capturedEvents", "pendingConversationMetadata", "sourceConversationReceipts", "uploadQueue", "captureSourceOwners"]);
  const config = local.ingestionConfig;
  if (!config?.enabled || !config.endpoint || !isUuid(config.workspaceId)) return { retained: false };
  if (!["chatgpt", "claude", "gemini"].includes(observation?.provider)
    || typeof observation.conversationId !== "string" || !observation.conversationId || observation.conversationId.length > 512
    || core.isProvisionalConversationId(observation.conversationId)
    || typeof observation.chatTitle !== "string" || !observation.chatTitle.trim() || observation.chatTitle.length > 1000
    || typeof observation.capturedAt !== "string" || !Number.isFinite(Date.parse(observation.capturedAt))
    || observation.sourceMetadata?.version !== 1 || !["source", "derived", "generic", "user", "unknown"].includes(observation.sourceMetadata.titleBasis)) {
    throw new Error("A valid captured conversation title observation is required.");
  }
  const identity = await captureIdentity();
  const sourceMetadata = { version: 1, titleBasis: observation.sourceMetadata.titleBasis,
    conversationIdentity: observation.sourceMetadata.conversationIdentity, messageIdentity: "unknown", timestampBasis: "unknown", linksStatus: "unknown", attachmentsStatus: "unknown" };
  const candidate = { provider: observation.provider, conversationId: observation.conversationId, chatTitle: observation.chatTitle.trim(), capturedAt: observation.capturedAt, sourceMetadata };
  const key = metadataIdentityKey(config, candidate.provider, candidate, identity.deviceId);
  const known = local.sourceConversationReceipts?.[key];
  // A local message is needed even before its receipt. Legacy unknown evidence
  // can never authorize an update. Receipt validation below is the queue gate.
  const captured = (local.capturedEvents || []).some(event => event.provider === candidate.provider
    && event.conversationId === candidate.conversationId && event.sourceMetadata?.version === 1
    && event.sourceMetadata.conversationIdentity === sourceMetadata.conversationIdentity
    && local.captureSourceOwners?.[JSON.stringify([event.provider, event.eventId])] === metadataScope(config));
  if (!key || (!known && !captured)) return { retained: false };
  const pending = local.pendingConversationMetadata || [];
  const existing = pending.find(item => item.key === key);
  const frozen = (local.uploadQueue || []).filter(item => item.payload.workspaceId === config.workspaceId
    && item.payload.provider === candidate.provider).flatMap(item => item.payload.conversationUpdates || []).filter(update =>
      update.conversationId === candidate.conversationId && update.sourceMetadata?.conversationIdentity === candidate.sourceMetadata.conversationIdentity);
  if ((existing && sameTitle(existing.observation, candidate))
    || (!existing && frozen.length && sameTitle(frozen.at(-1), candidate))
    || (!existing && !frozen.length && known && titleObservationCovered(known, candidate))) return { retained: true, unchanged: true };
  if (existing && Date.parse(existing.observation.capturedAt) > Date.parse(candidate.capturedAt)) return { retained: true, stale: true };
  if (!existing && pending.length >= 2000) throw new Error("Sherry's waiting title list is full. Capture will retry after earlier uploads finish.");
  await extensionApi.storage.local.set({ pendingConversationMetadata: [...pending.filter(item => item.key !== key), {
    key, scope: metadataScope(config), deviceId: identity.deviceId, observation: candidate
  }] });
  await scheduleUpload();
  void processUploadQueue();
  return { retained: true };
}

async function freezePendingConversationMetadata(config, capabilities) {
  if (capabilities.sourceMetadataVersion !== 1 || capabilities.conversationUpdatesVersion !== 1) return;
  const settings = await extensionApi.storage.sync.get(DEFAULT_SETTINGS);
  if (!settings.captureEnabled) return;
  const local = await extensionApi.storage.local.get(["ingestionConfig", "uploadQueue", "captureStats", "pendingConversationMetadata", "sourceConversationReceipts", "capturedEvents", "captureSourceOwners"]);
  if (!sameConnection(local.ingestionConfig, config)) return;
  const pending = local.pendingConversationMetadata || [];
  const known = local.sourceConversationReceipts || {};
  const queue = [...(local.uploadQueue || [])];
  const identity = await captureIdentity();
  // If an older server received a compatible payload without evidence, retain
  // the original rich local observation and establish it under a fresh batch.
  // This reuses an exact real event, never a fabricated message or new time.
  const proofEvents = [];
  for (const item of pending) {
    if (item.scope !== metadataScope(config) || known[item.key]) continue;
    if (item.observation.sourceMetadata.conversationIdentity !== "provider") continue;
    const alreadyQueued = queue.some(batch => batch.payload.workspaceId === config.workspaceId && batch.payload.provider === item.observation.provider
      && batch.payload.events?.some(event => metadataIdentityKey(config, batch.payload.provider, event, batch.payload.captureClient?.deviceId) === item.key));
    if (alreadyQueued) continue;
    const event = (local.capturedEvents || []).find(event => event.provider === item.observation.provider
      && event.sourceMetadata?.version === 1 && metadataIdentityKey(config, event.provider, event, identity.deviceId) === item.key
      && local.captureSourceOwners?.[JSON.stringify([event.provider, event.eventId])] === item.scope);
    if (event && !proofEvents.some(proof => proof.eventId === event.eventId)) proofEvents.push(event);
  }
  const proofBatches = createCaptureBatches(proofEvents, { ...config, ...identity }, "periodic_scan", { capabilities });
  const unfrozen = pending.filter(item => !queue.some(batch => batch.payload.workspaceId === config.workspaceId
    && batch.payload.provider === item.observation.provider && batch.payload.conversationUpdates?.some(update =>
      metadataIdentityKey(config, batch.payload.provider, update, batch.payload.captureClient?.deviceId) === item.key)));
  const eligible = unfrozen.filter(item => item.scope === metadataScope(config) && known[item.key]
    && !titleObservationCovered(known[item.key], item.observation));
  const settled = unfrozen.filter(item => item.scope === metadataScope(config) && known[item.key] && titleObservationCovered(known[item.key], item.observation));
  if (!eligible.length && !settled.length && !proofBatches.length) return;
  const observations = eligible.filter(item => item.observation.sourceMetadata.conversationIdentity !== "local" || item.deviceId === identity.deviceId);
  const batches = [...proofBatches, ...createConversationMetadataBatches(observations.map(item => item.observation), { ...config, ...identity }, { capabilities })];
  if (queue.length + batches.length > 100) return; // Retain unfrozen observations for the next alarm.
  queue.push(...batches.map(payload => ({ payload, attemptCount: 0, nextAttemptAt: Date.now(), lastError: null })));
  const removed = new Set([...observations, ...settled].map(item => item.key));
  await extensionApi.storage.local.set({ uploadQueue: queue, pendingConversationMetadata: pending.filter(item => !removed.has(item.key)),
    captureStats: { ...DEFAULT_STATS, ...local.captureStats, pendingBatches: queue.length } });
}

async function uploadBatch(config, item) {
  const response = await fetch(config.endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: {
      authorization: `Bearer ${config.accessToken}`,
      "content-type": "application/json",
      "idempotency-key": item.payload.batchId
    },
    body: JSON.stringify(item.payload)
  });
  return { response, responseBody: await response.json().catch(() => null) };
}

async function scheduleUpload() {
  // Repeating alarm survives background suspension. Recreate after browser restart.
  if (!await extensionApi.alarms.get(UPLOAD_ALARM)) {
    await extensionApi.alarms.create(UPLOAD_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  }
}

function sameConnection(left, right) {
  return left?.enabled && right?.enabled && left.workspaceId === right.workspaceId
    && left.endpoint === right.endpoint && left.accessToken === right.accessToken;
}

async function processUploadQueue() {
  if (uploadInFlight) return;
  uploadInFlight = true;
  try {
    await scheduleUpload();
    for (let processed = 0; processed < 5; processed += 1) {
      let local = await mutateLocal(() => extensionApi.storage.local.get(["ingestionConfig", "uploadQueue", "pendingConversationMetadata"]));
      if (local.ingestionConfig?.enabled && !local.ingestionConfig.blockedReason && local.pendingConversationMetadata?.length) {
        const capabilities = await sourceCapabilities(local.ingestionConfig);
        await mutateLocal(() => freezePendingConversationMetadata(local.ingestionConfig, capabilities));
        local = await mutateLocal(() => extensionApi.storage.local.get(["ingestionConfig", "uploadQueue"]));
      }
      let config = local.ingestionConfig;
      const item = local.uploadQueue?.[0];
      if (!config?.enabled || config.blockedReason || !config.accessToken || !item) return;
      // Pending work belongs to the account it was captured for.
      if (item.payload.workspaceId !== config.workspaceId || item.nextAttemptAt > Date.now()) return;
      const requiresSource = item.payload.events?.some(event => event.sourceMetadata) || item.payload.conversationUpdates?.length;
      if (requiresSource) {
        const capabilities = await sourceCapabilities(config);
        if (capabilities.sourceMetadataVersion !== 1 || (item.payload.conversationUpdates?.length && capabilities.conversationUpdatesVersion !== 1)) return;
        if (item.payload.conversationUpdates?.length && !(await extensionApi.storage.sync.get(DEFAULT_SETTINGS)).captureEnabled) return;
      }
      let response;
      let responseBody;
      try {
        ({ response, responseBody } = await uploadBatch(config, item));
        if (response.status === 401) {
          const refreshed = await refreshSupabaseSession(config);
          const current = await mutateLocal(async () => {
            const { ingestionConfig } = await extensionApi.storage.local.get("ingestionConfig");
            if (!sameConnection(ingestionConfig, config)) return null;
            if (refreshed) await extensionApi.storage.local.set({ ingestionConfig: refreshed });
            return refreshed;
          });
          if (current) {
            config = current;
            ({ response, responseBody } = await uploadBatch(config, item));
          }
        }
      } catch (error) {
        response = null;
        responseBody = { error: { message: error.message } };
      }

      const continueUploading = await mutateLocal(async () => {
        // Read fresh state AFTER the network request. Other captures may have arrived.
        const latest = await extensionApi.storage.local.get(["ingestionConfig", "uploadQueue", "captureStats", "quarantinedUploadBatches", "sourceConversationReceipts"]);
        if (!sameConnection(latest.ingestionConfig, config)) return false;
        const queue = latest.uploadQueue || [];
        const index = queue.findIndex((entry) => entry.payload.batchId === item.payload.batchId);
        if (index < 0) return false; // Disconnected or replaced while the request ran.
        const stats = { ...DEFAULT_STATS, ...latest.captureStats };
        const quarantined = latest.quarantinedUploadBatches || [];
        const at = new Date().toISOString();
        const receiptError = response?.ok ? uploadReceiptError(item.payload, responseBody) : null;
        if (response?.ok && !receiptError) {
          queue.splice(index, 1);
          const accepted = Number(responseBody?.result?.inserted || 0) + Number(responseBody?.result?.updated || 0);
          const sourceReceipts = { ...latest.sourceConversationReceipts };
          for (const observation of [...item.payload.events, ...(item.payload.conversationUpdates || [])]) {
            if (observation.sourceMetadata?.version !== 1) continue;
            const key = metadataIdentityKey(config, item.payload.provider, observation, item.payload.captureClient?.deviceId);
            if (!key) continue;
            const existing = sourceReceipts[key];
            if (!existing || Date.parse(observation.capturedAt) >= Date.parse(existing.capturedAt)) sourceReceipts[key] = {
              chatTitle: observation.chatTitle, capturedAt: observation.capturedAt, sourceMetadata: observation.sourceMetadata
            };
          }
          await extensionApi.storage.local.set({
            uploadQueue: queue,
            sourceConversationReceipts: sourceReceipts,
            captureStats: { ...stats, syncedEvents: stats.syncedEvents + accepted,
              pendingBatches: queue.length, lastSyncAt: at, lastSyncError: quarantined.length ? stats.lastSyncError : null }
          });
          await updateActionAlert({ quarantinedCount: quarantined.length });
          await appendDiagnostic({ provider: item.payload.provider, stage: "cloud_sync", status: "ok", at,
            detail: { batchId: item.payload.batchId, ...responseBody?.result, redactions: responseBody?.redactions?.total || 0 } });
          return true;
        }

        const attemptCount = item.attemptCount + 1;
        const status = response?.status || 0;
        const message = receiptError || responseBody?.error?.message || `Upload failed${status ? ` (${status})` : ""}`;
        const details = responseBody?.error?.details || null;
        const action = uploadFailureAction(status);
        if (action === "quarantine") {
          if (quarantined.length >= MAX_QUARANTINED_BATCHES) {
            const capacityError = "Sherry's rejected upload list is full. This upload remains waiting; no failed captures were removed.";
            queue[index] = { ...queue[index], attemptCount, nextAttemptAt: Date.now() + retryDelayMs(attemptCount), lastError: capacityError };
            await extensionApi.storage.local.set({ uploadQueue: queue,
              captureStats: { ...stats, pendingBatches: queue.length, lastSyncError: capacityError } });
            await updateActionAlert({ quarantinedCount: quarantined.length });
            await appendDiagnostic({ provider: item.payload.provider, stage: "cloud_sync_capacity", status: "error", at,
              detail: { batchId: item.payload.batchId, status, attemptCount, message: capacityError, originalError: message } });
            return false;
          }
          queue.splice(index, 1);
          quarantined.push({ batchId: item.payload.batchId, provider: item.payload.provider, status, message, details,
            eventCount: item.payload.events.length, conversationUpdateCount: item.payload.conversationUpdates?.length || 0,
            payload: item.payload, attemptCount, quarantinedAt: at });
          const trimmed = quarantined;
          await extensionApi.storage.local.set({ uploadQueue: queue, quarantinedUploadBatches: trimmed,
            captureStats: { ...stats, pendingBatches: queue.length, lastSyncError: message } });
          await updateActionAlert({ quarantinedCount: trimmed.length });
          await appendDiagnostic({ provider: item.payload.provider, stage: "cloud_sync_quarantine", status: "error", at,
            detail: { batchId: item.payload.batchId, status, attemptCount, message, details, continuingWithLaterBatches: true } });
          return true;
        }
        queue[index] = { ...queue[index], attemptCount, nextAttemptAt: Date.now() + retryDelayMs(attemptCount), lastError: message };
        const blockedReason = action === "block" ? message : action === "refresh_session"
          ? "Your cloud session expired. Sign in once to reconnect; captured messages remain safe locally." : null;
        await extensionApi.storage.local.set({ ingestionConfig: { ...latest.ingestionConfig, blockedReason }, uploadQueue: queue,
          captureStats: { ...stats, pendingBatches: queue.length, lastSyncError: message } });
        await updateActionAlert({ blockedReason, quarantinedCount: quarantined.length });
        await appendDiagnostic({ provider: item.payload.provider, stage: "cloud_sync", status: isPermanentUploadStatus(status) ? "error" : "warning", at,
          detail: { batchId: item.payload.batchId, status, attemptCount, action, message, details } });
        return false;
      });
      if (!continueUploading) return;
    }
    // The repeating alarm drains the remainder even if the worker now goes idle.
  } finally {
    uploadInFlight = false;
  }
}

async function updateIngestionConfig(payload, capabilities = {}) {
  const endpoint = normalizeIngestionEndpoint(payload?.endpoint);
  if (!isUuid(payload?.workspaceId)) throw new Error("A valid workspace ID is required.");
  const local = await extensionApi.storage.local.get(["capturedEvents", "uploadQueue", "captureStats", "ingestionConfig", "quarantinedUploadBatches", "pendingConversationMetadata"]);
  const sameAccount = local.ingestionConfig?.workspaceId === payload.workspaceId
    && local.ingestionConfig?.endpoint === endpoint;
  if (!sameAccount && (local.uploadQueue?.length || local.quarantinedUploadBatches?.length || local.pendingConversationMetadata?.length)) {
    throw new Error("Finish or disconnect the current account's pending uploads before connecting another account.");
  }
  const accessToken = typeof payload?.accessToken === "string" && payload.accessToken.trim()
    ? payload.accessToken.trim()
    : (sameAccount ? local.ingestionConfig?.accessToken : "") || "";
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
      : (sameAccount ? local.ingestionConfig?.refreshToken : "") || "",
    expiresAt: payload?.expiresAt || local.ingestionConfig?.expiresAt || null,
    blockedReason: null,
    updatedAt: new Date().toISOString()
  };
  let queue = local.uploadQueue || [];
  if (payload.uploadExisting && (local.capturedEvents || []).length) {
    const identity = await captureIdentity();
    const backfill = createCaptureBatches(local.capturedEvents, { ...config, ...identity }, "initial_backfill", sourceBatchOptions(config, capabilities))
      .map((batch) => ({ payload: batch, attemptCount: 0, nextAttemptAt: Date.now(), lastError: null }));
    const combined = [...queue, ...backfill];
    queue = boundedQueue(combined);
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

async function reuploadExistingCaptures(capabilities = {}) {
  const local = await extensionApi.storage.local.get(["capturedEvents", "uploadQueue", "captureStats", "ingestionConfig", "quarantinedUploadBatches"]);
  const config = local.ingestionConfig;
  if (!config?.enabled || !config.accessToken) throw new Error("Connect cloud sync before re-uploading captures.");
  const identity = await captureIdentity();
  const backfill = createCaptureBatches(local.capturedEvents || [], { ...config, ...identity }, "repair_backfill", sourceBatchOptions(config, capabilities))
    .map((batch) => ({ payload: batch, attemptCount: 0, nextAttemptAt: Date.now(), lastError: null }));
  const queue = boundedQueue([...(local.uploadQueue || []), ...backfill]);
  await extensionApi.storage.local.set({
    uploadQueue: queue,
    captureStats: { ...DEFAULT_STATS, ...local.captureStats, pendingBatches: queue.length, lastSyncError: null }
  });
  await scheduleUpload();
  void processUploadQueue();
  return safeIngestionStatus(config, queue, local.captureStats, local.quarantinedUploadBatches || []);
}

async function reuploadConversationCaptures({ provider, conversationId } = {}, capabilities = {}) {
  if (uploadInFlight) throw new Error("Wait for the current upload to finish, then try again.");
  const local = await extensionApi.storage.local.get(["capturedEvents", "uploadQueue", "captureStats", "ingestionConfig"]);
  const config = local.ingestionConfig;
  if (!config?.enabled || !config.accessToken) throw new Error("Connect cloud sync before repairing this chat.");
  if (local.uploadQueue?.length) throw new Error("Wait for pending uploads to finish, then repair this chat.");
  const events = selectConversationCaptures(local.capturedEvents, provider, conversationId);
  if (!events.length) throw new Error("No local captures were found for this chat.");
  const identity = await captureIdentity();
  const batches = createConversationRepairBatches(events, { ...config, ...identity }, provider, conversationId, sourceBatchOptions(config, capabilities));
  if (batches.length > 100) throw new Error("This chat needs more than 100 upload batches. Contact Sherry support.");
  const queue = batches.map((payload) => ({ payload, attemptCount: 0, nextAttemptAt: Date.now(), lastError: null }));
  await extensionApi.storage.local.set({
    uploadQueue: queue,
    captureStats: { ...DEFAULT_STATS, ...local.captureStats, pendingBatches: queue.length, lastSyncError: null }
  });
  await scheduleUpload();
  void processUploadQueue();
  return { ...safeIngestionStatus(config, queue, local.captureStats), queuedEvents: events.length, queuedBatches: batches.length };
}

async function countConversationCaptures({ provider, conversationId } = {}) {
  const { capturedEvents = [] } = await extensionApi.storage.local.get("capturedEvents");
  return selectConversationCaptures(capturedEvents, provider, conversationId).length;
}

async function rekeyConversation(fromConversationId, toConversationId, sourceUrl, capabilities = {}) {
  const { capturedEvents = [], captureStats = DEFAULT_STATS, uploadQueue = [], ingestionConfig, provisionalCaptureOwners = {} } = await extensionApi.storage.local.get([
    "capturedEvents", "captureStats", "uploadQueue", "ingestionConfig", "provisionalCaptureOwners"
  ]);
  if (!core.isProvisionalConversationId(fromConversationId) || !toConversationId || core.isProvisionalConversationId(toConversationId)) {
    throw new Error("A provisional chat and a permanent conversation ID are required.");
  }
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
  const queue = [...uploadQueue];
  const owner = provisionalCaptureOwners[fromConversationId];
  if (result.migrated && ingestionConfig?.enabled && ingestionConfig.accessToken
    && owner?.workspaceId === ingestionConfig.workspaceId && owner.endpoint === ingestionConfig.endpoint) {
    const identity = await captureIdentity();
    const events = core.rekeyCapturedEvents(sanitizedEvents.filter((event) => event.conversationId === fromConversationId),
      fromConversationId, toConversationId, sourceUrl).events;
    for (const payload of createCaptureBatches(events, { ...ingestionConfig, ...identity }, "initial_scan", sourceBatchOptions(ingestionConfig, capabilities))) {
      queue.push({ payload, attemptCount: 0, nextAttemptAt: Date.now(), lastError: null });
    }
  }
  boundedQueue(queue);
  delete provisionalCaptureOwners[fromConversationId];

  await extensionApi.storage.local.set({
    capturedEvents: storedEvents,
    uploadQueue: queue,
    provisionalCaptureOwners,
    captureStats: {
      ...captureStats,
      totalEvents: storedEvents.length,
      pendingBatches: queue.length,
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

  await scheduleUpload();
  void processUploadQueue();

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
  const settings = await extensionApi.storage.sync.get(DEFAULT_SETTINGS);
  if (Object.entries(allowed).some(([key, value]) => settings[key] !== value)) {
    throw new Error("The capture setting could not be saved.");
  }
  let recoveryWarning = null;
  try {
    if (allowed.captureEnabled) await restoreOpenTabs(extensionApi);
    const tabs = await extensionApi.tabs.query({ url: [
      "https://chatgpt.com/*", "https://chat.openai.com/*", "https://claude.ai/*", "https://gemini.google.com/*"
    ] });
    await Promise.allSettled(tabs.map((tab) => extensionApi.tabs.sendMessage(tab.id, { type: "SETTINGS_CHANGED" })));
  } catch {
    recoveryWarning = "Capture settings were saved, but open tabs could not be updated. Reload the intended chat tab.";
  }
  return { ok: true, settings, ...(recoveryWarning ? { recoveryWarning } : {}) };
}

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CAPTURE_BATCH") {
    Promise.resolve().then(async () => {
      const events = message.payload?.events ?? [];
      const { ingestionConfig } = await extensionApi.storage.local.get("ingestionConfig");
      const capabilities = events.some(event => event.sourceMetadata) ? await sourceCapabilities(ingestionConfig) : {};
      return mutateLocal(() => storeBatch(events, message.payload?.reason ?? "unknown", message.payload?.temporaryChat === true, capabilities));
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CONVERSATION_METADATA") {
    mutateLocal(() => storeConversationMetadata(message.payload))
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "DIAGNOSTIC_EVENT") {
    mutateLocal(() => appendDiagnostic(message.payload))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "REKEY_CONVERSATION") {
    const payload = message.payload ?? {};
    mutateWithSourceCapabilities(capabilities => rekeyConversation(
        payload.fromConversationId,
        payload.toConversationId,
        payload.sourceUrl,
        capabilities
      ))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_STATUS") {
    extensionStatusPayload().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "UPDATE_INGESTION_CONFIG") {
    Promise.resolve().then(() => message.payload?.uploadExisting
      ? mutateWithSourceCapabilities(capabilities => updateIngestionConfig(message.payload, capabilities), { ...message.payload, endpoint: normalizeIngestionEndpoint(message.payload.endpoint), enabled: true })
      : mutateLocal(() => updateIngestionConfig(message.payload)))
      .then((ingestion) => sendResponse({ ok: true, ingestion }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CLEAR_INGESTION_CONFIG") {
    mutateLocal(async () => {
      const { captureStats, ingestionConfig, uploadQueue = [], quarantinedUploadBatches = [] } = await extensionApi.storage.local.get([
        "captureStats", "ingestionConfig", "uploadQueue", "quarantinedUploadBatches"
      ]);
      // Disconnect removes credentials and stops collection/delivery. Frozen work
      // and its owner remain intact for reconnection; erasure is a separate action.
      await extensionApi.storage.sync.set({ captureEnabled: false });
      await extensionApi.storage.local.set({
        ...(ingestionConfig ? { ingestionConfig: { enabled: false, endpoint: ingestionConfig.endpoint, workspaceId: ingestionConfig.workspaceId,
          blockedReason: null, disconnectedAt: new Date().toISOString() } } : {}),
        captureStats: { ...DEFAULT_STATS, ...captureStats, pendingBatches: uploadQueue.length }
      });
      await updateActionAlert({ quarantinedCount: quarantinedUploadBatches.length });
    }).then(() => updateCaptureSettings({ captureEnabled: false }))
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "RETRY_UPLOADS") {
    mutateLocal(retryUploads).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "REUPLOAD_EXISTING") {
    mutateWithSourceCapabilities(capabilities => reuploadExistingCaptures(capabilities))
      .then((ingestion) => sendResponse({ ok: true, ingestion }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "REUPLOAD_CONVERSATION") {
    mutateWithSourceCapabilities(capabilities => reuploadConversationCaptures(message.payload, capabilities))
      .then((ingestion) => sendResponse({ ok: true, ingestion }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "COUNT_CONVERSATION_CAPTURES") {
    countConversationCaptures(message.payload)
      .then((count) => sendResponse({ ok: true, count }))
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
  if (message?.type === "UPDATE_INGESTION_CONFIG") {
    Promise.resolve().then(() => message.payload?.uploadExisting
      ? mutateWithSourceCapabilities(capabilities => updateIngestionConfig(message.payload, capabilities), { ...message.payload, endpoint: normalizeIngestionEndpoint(message.payload.endpoint), enabled: true })
      : mutateLocal(() => updateIngestionConfig(message.payload)))
      .then((ingestion) => sendResponse({ ok: true, ingestion }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "UPDATE_SETTINGS") {
    updateCaptureSettings(message.payload).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "RETRY_UPLOADS") {
    mutateLocal(retryUploads).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "REUPLOAD_EXISTING") {
    mutateWithSourceCapabilities(capabilities => reuploadExistingCaptures(capabilities)).then((ingestion) => sendResponse({ ok: true, ingestion })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "OPEN_DIAGNOSTICS") {
    extensionStatusPayload().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  sendResponse({ ok: false, error: "Unsupported extension control request." });
  return false;
});

async function retryUploads() {
  const { ingestionConfig, uploadQueue = [] } = await extensionApi.storage.local.get(["ingestionConfig", "uploadQueue"]);
  await extensionApi.storage.local.set({
    ...(ingestionConfig ? { ingestionConfig: { ...ingestionConfig, blockedReason: null } } : {}),
    uploadQueue: uploadQueue.map((item) => ({ ...item, nextAttemptAt: Date.now() }))
  });
  await scheduleUpload();
  void processUploadQueue();
}

extensionApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPLOAD_ALARM) void processUploadQueue();
});

function recoverExistingTabs() {
  void restoreOpenTabs(extensionApi).catch((error) => console.warn("Open tab recovery failed", error));
}
extensionApi.runtime.onInstalled.addListener(recoverExistingTabs);
extensionApi.runtime.onStartup.addListener(recoverExistingTabs);
extensionApi.permissions?.onAdded?.addListener(recoverExistingTabs);
extensionApi.tabs.onUpdated?.addListener((tabId, change, tab) => {
  if (change.status === "complete" || change.url) {
    void restoreTab(extensionApi, { ...tab, id: tabId }).catch(() => {});
  }
});
extensionApi.tabs.onActivated?.addListener(({ tabId }) => {
  void extensionApi.tabs.get(tabId).then((tab) => restoreTab(extensionApi, tab)).catch(() => {});
});

// This runs on every background wake, including restarts after an idle shutdown.
void mutateLocal(async () => {
  const { ingestionConfig, quarantinedUploadBatches = [] } = await extensionApi.storage.local.get(["ingestionConfig", "quarantinedUploadBatches"]);
  await updateActionAlert({ blockedReason: ingestionConfig?.blockedReason, quarantinedCount: quarantinedUploadBatches.length });
  await scheduleUpload();
}).then(() => processUploadQueue()).catch((error) => console.warn("Upload recovery failed", error));
