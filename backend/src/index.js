import { captureLimits, validateCaptureBatch } from "./validation.js";
import { redactCaptureBatch } from "./redaction.js";
import { getSummarizerSettings, saveSummarizerSettings, validateSummarizerSettings } from "./settings.js";
import { runSummarizationCycle } from "./summarization-service.js";
import {
  deleteSummary,
  editSummary,
  getSummary,
  listSummaries,
} from "./memory-review.js";
import { ensureRetrievalPermission, getSensitivitySettings, listConnections, searchMemory, updateSensitivitySettings, upsertRetrievalPermission } from "./retrieval.js";
import { activityFromEvents, conversationActivity, orderTranscriptEvents, transcriptCoverage } from "./conversation-activity.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function allowedOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  if (allowedOrigins(env).has(origin)) return true;
  if (String(env.ALLOW_FIREFOX_EXTENSION_ORIGINS || "").toLowerCase() !== "true") return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "moz-extension:"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.hostname)
      && (parsed.pathname === "" || parsed.pathname === "/");
  } catch {
    return false;
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin, env)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

function serviceHeaders(env, extra = {}) {
  return { apikey: supabaseSecretKey(env), authorization: `Bearer ${supabaseSecretKey(env)}`, ...extra };
}

async function supabaseJson(path, env, fetchImpl, options = {}) {
  const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: serviceHeaders(env, options.headers)
  });
  if (!response.ok) throw new Error(`Supabase request failed with ${response.status}`);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

async function ownedWorkspace(userId, workspaceId, env, fetchImpl) {
  const rows = await supabaseJson(
    `workspaces?id=eq.${encodeURIComponent(workspaceId)}&owner_user_id=eq.${encodeURIComponent(userId)}&select=id`,
    env,
    fetchImpl
  );
  return rows.length === 1;
}

async function listConversations(workspaceId, env, fetchImpl) {
  const [rows, rollups] = await Promise.all([
    supabaseJson(
      `conversations?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id,provider,provider_conversation_id,provider_family,product,primary_surface,title,canonical_chat_url,first_captured_at,last_captured_at,created_at,conversation_events(count)`,
      env,
      fetchImpl
    ),
    supabaseJson("rpc/conversation_activity_rollup", env, fetchImpl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ p_workspace_id: workspaceId })
    })
  ]);
  const activityByConversation = new Map((rollups || []).map((row) => [row.conversation_id, row]));
  return rows.map((conversation) => ({
    ...conversation,
    ...conversationActivity(
      conversation,
      [activityByConversation.get(conversation.id)?.source_message_at],
      [activityByConversation.get(conversation.id)?.first_new_content_at]
    )
  })).sort((left, right) => (Date.parse(right.last_activity_at || "") || 0) - (Date.parse(left.last_activity_at || "") || 0));
}

const PERSONAL_MEMORY_TAG = "sherry:personal";
const PERSONAL_ENTRY_TAG = "sherry:entry";
const PERSONAL_CATEGORY_TAG = "sherry:category";
const SENSITIVITY_CATEGORY_BY_NAME = new Map([["finance", "financial"], ["financial", "financial"], ["health", "health"], ["personal", "personal"]]);

function personalTag(prefix, value) {
  return `${prefix}:${encodeURIComponent(value)}`;
}

function personalTagValue(tags, prefix) {
  const value = (tags || []).find((tag) => tag.startsWith(`${prefix}:`));
  if (!value) return "";
  try {
    return decodeURIComponent(value.slice(prefix.length + 1));
  } catch {
    return "";
  }
}

function personalMemoryRecord(row) {
  const tags = row.tags || [];
  if (tags.includes(PERSONAL_CATEGORY_TAG)) {
    return { id: row.id, kind: "category", name: row.title, description: row.content, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  return {
    id: row.id,
    kind: "entry",
    category: personalTagValue(tags, "category"),
    fieldKey: personalTagValue(tags, "field"),
    label: row.title,
    content: row.content,
    isCustom: tags.includes("custom:true"),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validatePersonalMemoryPayload(payload) {
  const kind = payload?.kind;
  if (kind === "category") {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const description = typeof payload.description === "string" ? payload.description.trim() : "";
    if (!name || name.length > 80 || description.length > 140) return null;
    return { kind, title: name, content: description || "Custom personal memory category", tags: [PERSONAL_MEMORY_TAG, PERSONAL_CATEGORY_TAG, "sensitivity:personal"] };
  }
  if (kind === "entry") {
    const category = typeof payload.category === "string" ? payload.category.trim() : "";
    const fieldKey = typeof payload.fieldKey === "string" ? payload.fieldKey.trim() : "";
    const label = typeof payload.label === "string" ? payload.label.trim() : "";
    const content = typeof payload.content === "string" ? payload.content.trim() : "";
    if (!category || category.length > 80 || !fieldKey || fieldKey.length > 160 || !label || label.length > 200 || !content || content.length > 30000) return null;
    const sensitivity = SENSITIVITY_CATEGORY_BY_NAME.get(category.toLowerCase()) || "personal";
    return { kind, title: label, content, tags: [PERSONAL_MEMORY_TAG, PERSONAL_ENTRY_TAG, personalTag("category", category), personalTag("field", fieldKey), payload.isCustom === true ? "custom:true" : "custom:false", `sensitivity:${sensitivity}`] };
  }
  return null;
}

async function personalMemoryRows(workspaceId, env, fetchImpl) {
  const rows = await supabaseJson(
    `memory_notes?workspace_id=eq.${encodeURIComponent(workspaceId)}&authority=eq.user_authored&select=id,title,content,tags,created_at,updated_at&order=updated_at.desc`,
    env,
    fetchImpl
  );
  return rows.filter((row) => (row.tags || []).includes(PERSONAL_MEMORY_TAG));
}

async function listPersonalMemory(workspaceId, env, fetchImpl) {
  const records = (await personalMemoryRows(workspaceId, env, fetchImpl)).map(personalMemoryRecord);
  return { categories: records.filter((item) => item.kind === "category"), entries: records.filter((item) => item.kind === "entry") };
}

async function createPersonalMemory(workspaceId, payload, env, fetchImpl) {
  const value = validatePersonalMemoryPayload(payload);
  if (!value) return null;
  const rows = await supabaseJson("memory_notes", env, fetchImpl, {
    method: "POST",
    headers: { "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify({ workspace_id: workspaceId, title: value.title, content: value.content, tags: value.tags, authority: "user_authored" })
  });
  return personalMemoryRecord(rows[0]);
}

async function updatePersonalMemory(workspaceId, id, payload, env, fetchImpl) {
  const value = validatePersonalMemoryPayload(payload);
  if (!value) return null;
  const rows = await supabaseJson(`memory_notes?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=eq.${encodeURIComponent(id)}`, env, fetchImpl, {
    method: "PATCH",
    headers: { "content-type": "application/json", prefer: "return=representation" },
    body: JSON.stringify({ title: value.title, content: value.content, tags: value.tags, updated_at: new Date().toISOString() })
  });
  return rows[0] ? personalMemoryRecord(rows[0]) : undefined;
}

async function deletePersonalMemory(workspaceId, id, env, fetchImpl) {
  const rows = await personalMemoryRows(workspaceId, env, fetchImpl);
  const target = rows.find((row) => row.id === id);
  if (!target) return false;
  const targetRecord = personalMemoryRecord(target);
  const ids = [id];
  if (targetRecord.kind === "category") {
    ids.push(...rows.filter((row) => {
      const record = personalMemoryRecord(row);
      return record.kind === "entry" && record.category === targetRecord.name;
    }).map((row) => row.id));
  }
  await supabaseJson(`memory_notes?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=in.(${ids.join(",")})`, env, fetchImpl, { method: "DELETE" });
  return true;
}

function addCount(map, key, amount = 1) {
  const normalized = String(key || "unknown").trim().toLowerCase() || "unknown";
  map.set(normalized, (map.get(normalized) || 0) + amount);
}

function sortedBreakdown(map, keyName = "key") {
  return [...map.entries()]
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((a, b) => b.count - a.count || a[keyName].localeCompare(b[keyName]));
}

export function buildDashboardMetrics({ conversations = [], checkpoints = [], retrievalRequests = [], notes = [], textChunks = [] }) {
  const conversationById = new Map(conversations.map((item) => [item.id, item]));
  const checkpointById = new Map(checkpoints.map((item) => [item.id, item]));
  const noteById = new Map(notes.map((item) => [String(item.id), item.title]));
  const chunkById = new Map(textChunks.map((item) => [String(item.id), item]));
  const conversationsByTool = new Map();
  const messagesByTool = new Map();
  const platformToolPairs = new Map();
  let totalMessages = 0;

  for (const conversation of conversations) {
    const tool = conversation.product || conversation.provider || "unknown";
    const surface = conversation.primary_surface || "unknown";
    const messageCount = Number(conversation.conversation_events?.[0]?.count || 0);
    addCount(conversationsByTool, tool);
    addCount(messagesByTool, tool, messageCount);
    addCount(platformToolPairs, `${surface}::${tool}`);
    totalMessages += messageCount;
  }

  const useCaseMap = new Map();
  for (const checkpoint of checkpoints) {
    const provider = conversationById.get(checkpoint.conversation_id)?.product
      || conversationById.get(checkpoint.conversation_id)?.provider
      || "unknown";
    for (const topic of new Set(checkpoint.topics || [])) {
      const normalized = String(topic || "").trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (!useCaseMap.has(key)) useCaseMap.set(key, { name: normalized, count: 0, tools: new Map() });
      const useCase = useCaseMap.get(key);
      useCase.count += 1;
      addCount(useCase.tools, provider);
    }
  }
  const useCases = [...useCaseMap.values()]
    .map((item) => ({ name: item.name, count: item.count, tools: sortedBreakdown(item.tools, "tool") }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const retrievalByTool = new Map();
  const memoryUses = new Map();
  for (const request of retrievalRequests) {
    addCount(retrievalByTool, request.provider || "unknown");
    for (const reference of Array.isArray(request.result_refs) ? request.result_refs : []) {
      if (!reference?.id || !reference?.type || reference.type === "claim") continue;
      const key = `${reference.type}:${reference.id}`;
      memoryUses.set(key, {
        id: String(reference.id),
        type: String(reference.type),
        count: (memoryUses.get(key)?.count || 0) + 1
      });
    }
  }

  const mostUsedMemories = [...memoryUses.values()]
    .map((item) => {
      let label = null;
      if (item.type === "note") label = noteById.get(item.id);
      if (item.type === "summary") {
        const checkpoint = checkpointById.get(item.id);
        const conversation = checkpoint ? conversationById.get(checkpoint.conversation_id) : null;
        label = conversation?.title ? `Summary: ${conversation.title}` : "Conversation summary";
      }
      let conversationId = null;
      let sourceTitle = null;
      let sourceProvider = null;
      let excerpt = null;
      let sourceEventId = null;
      if (item.type === "excerpt") {
        const chunk = chunkById.get(item.id);
        const conversation = chunk?.conversations || conversationById.get(chunk?.conversation_id);
        conversationId = chunk?.conversation_id || conversation?.id || null;
        sourceTitle = conversation?.title || null;
        sourceProvider = conversation?.provider || conversation?.product || null;
        excerpt = chunk?.content ? String(chunk.content).replace(/\s+/g, " ").trim().slice(0, 240) : null;
        sourceEventId = chunk?.source_event_id || null;
        label = excerpt || (sourceTitle ? `Excerpt from ${sourceTitle}` : `Conversation excerpt · ${item.id.slice(0, 8)}`);
      }
      return { ...item, label: label || `${item.type} memory`, conversationId, sourceTitle, sourceProvider, excerpt, sourceEventId };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 5);

  return {
    generatedAt: new Date().toISOString(),
    chats: {
      total: conversations.length,
      totalMessages,
      byTool: sortedBreakdown(conversationsByTool, "tool")
    },
    messagesByTool: sortedBreakdown(messagesByTool, "tool"),
    platformToolPairs: sortedBreakdown(platformToolPairs, "pair").map((item) => {
      const [platform, tool] = item.pair.split("::");
      return { platform, tool, count: item.count };
    }),
    useCases: useCases.slice(0, 8),
    summaryCoverage: { summarizedChats: new Set(checkpoints.map((item) => item.conversation_id).filter(Boolean)).size, capturedChats: conversations.length },
    retrieval: {
      total: retrievalRequests.length,
      byTool: sortedBreakdown(retrievalByTool, "tool"),
      mostUsedMemories
    },
    artifacts: {
      indexed: false,
      total: null,
      byType: [],
      message: "Artifact metadata is not indexed yet. Sherry will show types here once capture supports it."
    }
  };
}

async function dashboardMetrics(workspaceId, env, fetchImpl) {
  const encodedWorkspaceId = encodeURIComponent(workspaceId);
  const [conversations, checkpoints, retrievalRequests, notes] = await Promise.all([
    supabaseJson(
      `conversations?workspace_id=eq.${encodedWorkspaceId}&select=id,title,provider,product,primary_surface,conversation_events(count)&order=last_captured_at.desc&limit=1000`,
      env,
      fetchImpl
    ),
    supabaseJson(
      `checkpoints?workspace_id=eq.${encodedWorkspaceId}&status=in.(active,user_edited)&select=id,conversation_id,topics&order=created_at.desc&limit=500`,
      env,
      fetchImpl
    ),
    supabaseJson(
      `retrieval_requests?workspace_id=eq.${encodedWorkspaceId}&outcome=eq.success&tool_name=eq.memory.search&provider=neq.web_test&select=provider,result_refs,result_count,created_at&order=created_at.desc&limit=500`,
      env,
      fetchImpl
    ),
    supabaseJson(
      `memory_notes?workspace_id=eq.${encodedWorkspaceId}&select=id,title&order=updated_at.desc&limit=500`,
      env,
      fetchImpl
    ),
  ]);
  const excerptCounts = new Map();
  for (const request of retrievalRequests) for (const ref of Array.isArray(request.result_refs) ? request.result_refs : []) {
    if (ref?.type === "excerpt" && ref.id != null) excerptCounts.set(String(ref.id), (excerptCounts.get(String(ref.id)) || 0) + 1);
  }
  const excerptIds = [...excerptCounts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
  const textChunks = excerptIds.length ? await supabaseJson(
    `text_chunks?workspace_id=eq.${encodedWorkspaceId}&id=in.(${excerptIds.map(encodeURIComponent).join(",")})&select=id,conversation_id,source_event_id,content,conversations(id,title,provider,product)`,
    env,
    fetchImpl
  ) : [];
  return buildDashboardMetrics({ conversations, checkpoints, retrievalRequests, notes, textChunks });
}

async function diagnosticsStatus(workspaceId, env, fetchImpl) {
  const results = await Promise.allSettled([
    supabaseJson(
      `summarization_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=conversation_id,status,error_code,error_detail,provider,model,created_at,completed_at&order=created_at.desc&limit=200`,
      env,
      fetchImpl
    ),
    supabaseJson(
      `diagnostic_events?workspace_id=eq.${encodeURIComponent(workspaceId)}&status=in.(warning,error)&select=stage,status,detail,created_at&order=created_at.desc&limit=50`,
      env,
      fetchImpl
    ),
    supabaseJson(
      `ingestion_batches?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=created_at,provider,received_count&order=created_at.desc&limit=1`,
      env,
      fetchImpl
    ),
    supabaseJson(
      `conversations?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id,title,provider&limit=1000`,
      env,
      fetchImpl
    )
  ]);
  const [jobsResult, diagnosticsResult, latestBatchResult, conversationsResult] = results;
  const jobs = jobsResult.status === "fulfilled" ? jobsResult.value : [];
  const diagnostics = diagnosticsResult.status === "fulfilled" ? diagnosticsResult.value : [];
  const latestBatch = latestBatchResult.status === "fulfilled" ? latestBatchResult.value : [];
  const conversations = conversationsResult.status === "fulfilled" ? conversationsResult.value : [];
  const unavailableSources = [
    ["summarization jobs", jobsResult],
    ["diagnostic events", diagnosticsResult],
    ["capture batches", latestBatchResult],
    ["stored conversations", conversationsResult]
  ].filter(([, result]) => result.status === "rejected").map(([label]) => label);
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const latestJobByConversation = new Map();
  for (const job of jobs) {
    if (!latestJobByConversation.has(job.conversation_id)) latestJobByConversation.set(job.conversation_id, job);
  }
  const activeFailures = [...latestJobByConversation.values()].filter((job) => ["failed", "skipped"].includes(job.status));
  const alerts = [];
  if (unavailableSources.length) {
    alerts.push({
      id: "diagnostics-partial",
      severity: "warning",
      title: "Some health checks are temporarily unavailable",
      message: `Sherry could not verify ${unavailableSources.join(", ")}. Available live checks are still shown below.`,
      action: "Refresh Diagnostics. If the same checks remain unavailable, review the database schema and Worker logs.",
      latestAt: new Date().toISOString()
    });
  }
  if (activeFailures.length) {
    const codes = [...new Set(activeFailures.map((job) => job.error_code || "summarization_failed"))];
    alerts.push({
      id: "summarization-failures",
      severity: "error",
      title: "Some conversations are not being summarized",
      message: `${activeFailures.length} conversation${activeFailures.length === 1 ? " has" : "s have"} a failed latest summary. Memory will not spend more model tokens on unchanged input.`,
      action: "Add or edit a source message, change the summarizer configuration, or wait for a repaired runtime before retrying.",
      codes,
      latestAt: activeFailures[0]?.created_at || null
    });
  }
  const failures = activeFailures.map((job) => {
    const conversation = conversationById.get(job.conversation_id);
    return {
      conversationId: job.conversation_id,
      conversationTitle: conversation?.title || "Untitled conversation",
      conversationProvider: conversation?.provider || null,
      provider: job.provider || null,
      model: job.model || null,
      errorCode: job.error_code || "summarization_failed",
      errorDetail: job.error_detail || "The summarization provider did not complete this job.",
      createdAt: job.created_at || null
    };
  });
  const stages = [
    { id: "capture", label: "Capture", status: latestBatch[0] ? "ready" : "waiting", detail: latestBatch[0] ? `Latest cloud capture received ${latestBatch[0].received_count || 0} event${latestBatch[0].received_count === 1 ? "" : "s"}.` : "No cloud capture batch has been received yet." },
    { id: "upload", label: "Upload", status: latestBatch[0] ? "ready" : "waiting", detail: latestBatch[0] ? "The extension-to-cloud ingestion endpoint is receiving batches." : "Waiting for an extension upload." },
    { id: "index", label: "Index", status: conversations.length ? "ready" : "waiting", detail: conversations.length ? `${conversations.length} conversation${conversations.length === 1 ? " is" : "s are"} stored and available to the app.` : "Nothing has been indexed yet." },
    { id: "summarize", label: "Summarize", status: failures.length ? "error" : "ready", detail: failures.length ? `${failures.length} latest summarization job${failures.length === 1 ? " needs" : "s need"} attention.` : "No active summarization failures were found." },
    { id: "retrieve", label: "Retrieve", status: "ready", detail: "The authenticated memory retrieval endpoint is available." }
  ];
  return {
    status: activeFailures.length || unavailableSources.length ? "degraded" : "healthy",
    alerts,
    protections: {
      unchangedFailedInputBlocked: true,
      invalidClaimsDroppedIndividually: true,
      activeFailedConversations: activeFailures.length
    },
    failures,
    sanitizedCount: 0,
    stages,
    latestCloudCaptureAt: latestBatch[0]?.created_at || null,
    checkedAt: new Date().toISOString()
  };
}

async function conversationDetail(workspaceId, conversationId, env, fetchImpl) {
  const conversations = await supabaseJson(
    `conversations?id=eq.${encodeURIComponent(conversationId)}&workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id,provider,provider_conversation_id,title,canonical_chat_url,first_captured_at,last_captured_at,coverage_state,gap_detected,backfill_available`,
    env,
    fetchImpl
  );
  if (!conversations.length) return null;
  const events = await supabaseJson(
    `conversation_events?conversation_id=eq.${encodeURIComponent(conversationId)}&workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id,event_key,provider_message_id,sequence,role,text_content,source_url,source_locator,message_timestamp,captured_at,first_captured_at,revision,raw_object_key,coverage_state&order=first_captured_at.asc`,
    env,
    fetchImpl
  );
  return { ...conversations[0], ...activityFromEvents(conversations[0], events), transcriptCoverage: transcriptCoverage(conversations[0], events), events: orderTranscriptEvents(events) };
}

async function conversationEventIdentities(workspaceId, conversationId, env, fetchImpl) {
  const conversations = await supabaseJson(
    `conversations?id=eq.${encodeURIComponent(conversationId)}&workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id,provider,provider_conversation_id`,
    env, fetchImpl
  );
  if (!conversations.length) return null;
  const events = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await supabaseJson(
      `conversation_events?conversation_id=eq.${encodeURIComponent(conversationId)}&workspace_id=eq.${encodeURIComponent(workspaceId)}&select=provider_message_id,role&order=id.asc&limit=${pageSize}&offset=${offset}`,
      env, fetchImpl
    );
    events.push(...page);
    if (page.length < pageSize) break;
  }
  return { conversation: conversations[0], events };
}

async function rewriteArchiveWithoutConversation(objectKey, providerConversationId, env) {
  const object = await env.RAW_MEMORY.get(objectKey);
  if (!object) return { deleted: false, missing: true, sha256: null, bytes: 0 };
  const archive = await object.json();
  if (!Array.isArray(archive.events)) throw new Error("Raw archive has no event list");
  const remaining = archive.events.filter((event) => event.conversationId !== providerConversationId);
  if (remaining.length === archive.events.length) return { unchanged: true };
  archive.events = remaining;
  if (archive.events.length === 0) {
    await env.RAW_MEMORY.delete(objectKey);
    return { deleted: true, sha256: null, bytes: 0 };
  }
  const body = JSON.stringify(archive);
  const sha256 = await sha256Hex(body);
  await env.RAW_MEMORY.put(objectKey, body, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { ...(object.customMetadata || {}), sha256 }
  });
  return {
    deleted: false,
    sha256,
    bytes: new TextEncoder().encode(body).byteLength,
    providerConversationIds: [...new Set(remaining.map((event) => event.conversationId))]
  };
}

async function archiveKeysForConversation(workspaceId, provider, providerConversationId, env, fetchImpl) {
  const keys = new Set();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await supabaseJson(
      `ingestion_batches?workspace_id=eq.${encodeURIComponent(workspaceId)}&provider=eq.${encodeURIComponent(provider)}&select=raw_object_key,provider_conversation_ids&order=id.asc&limit=${pageSize}&offset=${offset}`,
      env, fetchImpl
    );
    for (const batch of page) {
      // Legacy duplicate-only batches have no event row to backfill this index.
      // Inspect their archives so deleting a chat also removes those copies.
      if (!Array.isArray(batch.provider_conversation_ids)
        || batch.provider_conversation_ids.includes(providerConversationId)) keys.add(batch.raw_object_key);
    }
    if (page.length < pageSize) break;
  }
  return keys;
}

async function updateArchiveBatchMetadata(workspaceId, archiveResults, env, fetchImpl) {
  for (const archive of archiveResults) {
    const batchPath = `ingestion_batches?workspace_id=eq.${encodeURIComponent(workspaceId)}&raw_object_key=eq.${encodeURIComponent(archive.key)}`;
    if (archive.unchanged) continue;
    if (archive.missing) {
      const references = await supabaseJson(
        `conversation_events?workspace_id=eq.${encodeURIComponent(workspaceId)}&raw_object_key=eq.${encodeURIComponent(archive.key)}&select=id&limit=1`,
        env, fetchImpl
      );
      if (references.length) continue;
    }
    if (archive.deleted || archive.missing) {
      await supabaseJson(batchPath, env, fetchImpl, { method: "DELETE" });
    } else {
      await supabaseJson(batchPath, env, fetchImpl, {
        method: "PATCH",
        headers: { "content-type": "application/json", prefer: "return=minimal" },
        body: JSON.stringify({ payload_sha256: archive.sha256, payload_bytes: archive.bytes, provider_conversation_ids: archive.providerConversationIds })
      });
    }
  }
}

async function markArchiveReconciled(workspaceId, provider, providerConversationId, env, fetchImpl) {
  await supabaseJson(
    `deleted_conversations?workspace_id=eq.${encodeURIComponent(workspaceId)}&provider=eq.${encodeURIComponent(provider)}&provider_conversation_id=eq.${encodeURIComponent(providerConversationId)}`,
    env, fetchImpl,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", prefer: "return=minimal" },
      body: JSON.stringify({ archive_reconciled_at: new Date().toISOString() })
    }
  );
}

async function deleteConversation(workspaceId, conversationId, env, fetchImpl) {
  const detail = await conversationDetail(workspaceId, conversationId, env, fetchImpl);
  if (!detail) return null;
  const keySet = await archiveKeysForConversation(workspaceId, detail.provider, detail.provider_conversation_id, env, fetchImpl);
  for (const event of detail.events) if (event.raw_object_key) keySet.add(event.raw_object_key);
  const keys = [...keySet];
  // Record the deletion before touching external storage. If R2 fails, the
  // scheduled reconciler can finish from this durable tombstone.
  await supabaseJson("deleted_conversations", env, fetchImpl, {
    method: "POST",
    headers: { "content-type": "application/json", prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify({ workspace_id: workspaceId, provider: detail.provider, provider_conversation_id: detail.provider_conversation_id })
  });
  await supabaseJson(`conversations?id=eq.${encodeURIComponent(conversationId)}&workspace_id=eq.${encodeURIComponent(workspaceId)}`, env, fetchImpl, { method: "DELETE" });
  try {
    const archiveResults = [];
    for (const key of keys) {
      const archive = await rewriteArchiveWithoutConversation(key, detail.provider_conversation_id, env);
      archiveResults.push({ key, ...archive });
    }
    await updateArchiveBatchMetadata(workspaceId, archiveResults, env, fetchImpl);
    await markArchiveReconciled(workspaceId, detail.provider, detail.provider_conversation_id, env, fetchImpl);
    return { id: conversationId, rawArchivesUpdated: archiveResults.filter((archive) => archive.deleted || archive.sha256).length, cleanupPending: false };
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "conversation_archive_cleanup_pending", conversationId, message: error?.message || "Unknown error" }));
    return { id: conversationId, rawArchivesUpdated: 0, cleanupPending: true };
  }
}

export async function reconcileDeletedArchives(env, fetchImpl = globalThis.fetch) {
  const tombstones = await supabaseJson(
    "deleted_conversations?archive_reconciled_at=is.null&select=id,workspace_id,provider,provider_conversation_id&order=deleted_at.asc,id.asc&limit=10",
    env, fetchImpl
  );
  let reconciled = 0;
  for (const tombstone of tombstones) {
    try {
      const active = await supabaseJson(
        `conversations?workspace_id=eq.${encodeURIComponent(tombstone.workspace_id)}&provider=eq.${encodeURIComponent(tombstone.provider)}&provider_conversation_id=eq.${encodeURIComponent(tombstone.provider_conversation_id)}&select=id&limit=1`,
        env, fetchImpl
      );
      if (active.length) continue;
      const keys = await archiveKeysForConversation(tombstone.workspace_id, tombstone.provider, tombstone.provider_conversation_id, env, fetchImpl);
      const results = [];
      for (const key of keys) results.push({ key, ...await rewriteArchiveWithoutConversation(key, tombstone.provider_conversation_id, env) });
      await updateArchiveBatchMetadata(tombstone.workspace_id, results, env, fetchImpl);
      await markArchiveReconciled(tombstone.workspace_id, tombstone.provider, tombstone.provider_conversation_id, env, fetchImpl);
      reconciled += 1;
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "archive_reconciliation_failed", tombstoneId: tombstone.id, message: error?.message || "Unknown error" }));
    }
  }
  return { checked: tombstones.length, reconciled };
}

async function omitDeletedConversations(batch, env, fetchImpl) {
  const rows = await supabaseJson(
    `deleted_conversations?workspace_id=eq.${encodeURIComponent(batch.workspaceId)}&provider=eq.${encodeURIComponent(batch.provider)}&select=provider_conversation_id`,
    env,
    fetchImpl
  );
  const deleted = new Set(rows.map((row) => row.provider_conversation_id));
  const events = batch.events.filter((event) => !deleted.has(event.conversationId));
  return { ...batch, events, omitted: batch.events.length - events.length };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function apiError(code, message, status, requestId, headers = {}, details) {
  return jsonResponse({ error: { code, message, requestId, ...(details ? { details } : {}) } }, status, headers);
}

function bearerToken(request) {
  const value = request.headers.get("authorization") || "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function boundedJson(request, maximumBytes) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maximumBytes) return { error: "too_large" };
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > maximumBytes) return { error: "too_large" };
  if (!rawBody.trim()) return { value: {} };
  try {
    return { value: JSON.parse(rawBody) };
  } catch {
    return { error: "invalid_json" };
  }
}

function supabaseSecretKey(env) {
  return env.SUPABASE_SECRET_KEY || env.supabase_secret_key;
}

function configured(env) {
  return Boolean(
    env.RAW_MEMORY
    && env.SUPABASE_URL
    && !String(env.SUPABASE_URL).includes("replace-with")
    && env.SUPABASE_PUBLISHABLE_KEY
    && !String(env.SUPABASE_PUBLISHABLE_KEY).includes("replace_me")
    && supabaseSecretKey(env)
  );
}

async function authenticate(request, env, fetchImpl) {
  const token = bearerToken(request);
  if (!token) return null;
  const response = await fetchImpl(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) return null;
  const user = await response.json();
  return typeof user?.id === "string" ? user : null;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rawObjectKey(batch) {
  const date = new Date(batch.clientCreatedAt);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${batch.workspaceId}/${batch.provider}/${year}/${month}/${day}/${batch.batchId}.json`;
}

async function commitMetadata(batch, metadata, env, fetchImpl) {
  const isV2 = batch.schemaVersion === 2;
  return fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/${isV2 ? "ingest_capture_batch_v2" : "ingest_capture_batch"}`, {
    method: "POST",
    headers: {
      apikey: supabaseSecretKey(env),
      "content-type": "application/json"
    },
    body: JSON.stringify({
      p_user_id: metadata.userId,
      p_workspace_id: batch.workspaceId,
      p_batch_id: batch.batchId,
      p_provider: batch.provider,
      ...(isV2 ? {
        p_provider_family: batch.providerFamily,
        p_product: batch.product,
        p_surface: batch.surface,
        p_capture_client: batch.captureClient,
        p_coverage: batch.coverage
      } : {}),
      p_reason: batch.reason,
      p_raw_object_key: metadata.rawObjectKey,
      p_payload_sha256: metadata.payloadSha256,
      p_payload_bytes: metadata.payloadBytes,
      p_redaction_summary: metadata.redactionSummary,
      p_events: batch.events
    })
  });
}

export async function handleRequest(request, env, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const requestId = request.headers.get("cf-ray") || crypto.randomUUID();
  const cors = corsHeaders(request, env);
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    const origin = request.headers.get("origin");
    if (origin && !isAllowedOrigin(origin, env)) {
      return apiError("origin_not_allowed", "This browser origin is not allowed.", 403, requestId);
    }
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true, service: "shared-memory-ingestion", configured: configured(env) }, 200, cors);
  }

  const conversationMatch = url.pathname.match(/^\/v1\/conversations\/([0-9a-f-]+)$/i);
  const conversationIdentitiesMatch = url.pathname.match(/^\/v1\/conversations\/([0-9a-f-]+)\/event-identities$/i);
  const summaryMatch = url.pathname.match(/^\/v1\/summaries\/([0-9a-f-]+)$/i);
  const claimReviewMatch = url.pathname.match(/^\/v1\/memories\/([0-9a-f-]+)\/review$/i);
  const conflictResolveMatch = url.pathname.match(/^\/v1\/conflicts\/([0-9a-f-]+)\/resolve$/i);
  const personalMemoryMatch = url.pathname.match(/^\/v1\/personal-memory\/([0-9a-f-]+)$/i);
  const isSettingsRoute = url.pathname === "/v1/settings/summarizer";
  const isSummaryRunRoute = url.pathname === "/v1/summaries/run";
  const isSummariesRoute = url.pathname === "/v1/summaries";
  const isMemoriesRoute = url.pathname === "/v1/memories";
  const isRetrievalConnectionsRoute = url.pathname === "/v1/retrieval/connections";
  const isSensitivityRoute = url.pathname === "/v1/retrieval/sensitivity";
  const isRetrievalTestRoute = url.pathname === "/v1/retrieval/test";
  const isDiagnosticsRoute = url.pathname === "/v1/diagnostics/status";
  const isDashboardRoute = url.pathname === "/v1/dashboard";
  const isPersonalMemoryRoute = url.pathname === "/v1/personal-memory";
  const isMemoryRoute = url.pathname === "/v1/conversations"
    || Boolean(conversationMatch)
    || Boolean(conversationIdentitiesMatch)
    || isSettingsRoute
    || isSummaryRunRoute
    || isSummariesRoute
    || Boolean(summaryMatch)
    || isMemoriesRoute
    || Boolean(claimReviewMatch)
    || Boolean(conflictResolveMatch)
    || isRetrievalConnectionsRoute
    || isSensitivityRoute
    || isRetrievalTestRoute
    || isDiagnosticsRoute
    || isDashboardRoute;
  const isWorkspaceRoute = isMemoryRoute || isPersonalMemoryRoute || Boolean(personalMemoryMatch);

  if (isWorkspaceRoute) {
    if (!configured(env)) return apiError("service_not_configured", "The memory service is not configured.", 503, requestId, cors);
    let user;
    try {
      user = await authenticate(request, env, fetchImpl);
    } catch {
      return apiError("auth_unavailable", "Authentication is temporarily unavailable.", 503, requestId, cors);
    }
    if (!user) return apiError("unauthorized", "A valid signed-in session is required.", 401, requestId, cors);
    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) return apiError("workspace_required", "workspaceId is required.", 400, requestId, cors);
    try {
      if (!await ownedWorkspace(user.id, workspaceId, env, fetchImpl)) {
        return apiError("workspace_forbidden", "This account cannot access the selected workspace.", 403, requestId, cors);
      }
      if (request.method === "GET" && isSummariesRoute) {
        return jsonResponse({ summaries: await listSummaries(workspaceId, env, fetchImpl) }, 200, cors);
      }
      if (request.method === "GET" && isDiagnosticsRoute) {
        return jsonResponse(await diagnosticsStatus(workspaceId, env, fetchImpl), 200, cors);
      }
      if (request.method === "GET" && isDashboardRoute) {
        return jsonResponse(await dashboardMetrics(workspaceId, env, fetchImpl), 200, cors);
      }
      if (request.method === "GET" && isPersonalMemoryRoute) {
        return jsonResponse(await listPersonalMemory(workspaceId, env, fetchImpl), 200, cors);
      }
      if (request.method === "POST" && isPersonalMemoryRoute) {
        const parsed = await boundedJson(request, 32768);
        if (parsed.error) return apiError("invalid_request", "Personal memory must be valid JSON under 32 KB.", 400, requestId, cors);
        const record = await createPersonalMemory(workspaceId, parsed.value, env, fetchImpl);
        return record ? jsonResponse({ record }, 201, cors) : apiError("invalid_personal_memory", "Complete the required personal memory fields.", 422, requestId, cors);
      }
      if (request.method === "PUT" && personalMemoryMatch) {
        const parsed = await boundedJson(request, 32768);
        if (parsed.error) return apiError("invalid_request", "Personal memory must be valid JSON under 32 KB.", 400, requestId, cors);
        const record = await updatePersonalMemory(workspaceId, personalMemoryMatch[1], parsed.value, env, fetchImpl);
        if (record === null) return apiError("invalid_personal_memory", "Complete the required personal memory fields.", 422, requestId, cors);
        return record ? jsonResponse({ record }, 200, cors) : apiError("not_found", "Personal memory not found.", 404, requestId, cors);
      }
      if (request.method === "DELETE" && personalMemoryMatch) {
        return await deletePersonalMemory(workspaceId, personalMemoryMatch[1], env, fetchImpl)
          ? jsonResponse({ ok: true }, 200, cors)
          : apiError("not_found", "Personal memory not found.", 404, requestId, cors);
      }
      if (request.method === "GET" && summaryMatch) {
        const summary = await getSummary(workspaceId, summaryMatch[1], env, fetchImpl);
        return summary ? jsonResponse({ summary }, 200, cors) : apiError("not_found", "Summary not found.", 404, requestId, cors);
      }
      if (request.method === "PUT" && summaryMatch) {
        const parsed = await boundedJson(request, 32768);
        if (parsed.error === "too_large") return apiError("request_too_large", "The summary edit exceeds the 32 KB limit.", 413, requestId, cors);
        if (parsed.error) return apiError("invalid_json", "The request body must be valid JSON.", 400, requestId, cors);
        const summaryText = typeof parsed.value.summaryText === "string" ? parsed.value.summaryText.trim() : "";
        if (!summaryText || summaryText.length > 30000) {
          return apiError("invalid_summary", "The edited summary must contain between 1 and 30,000 characters.", 422, requestId, cors);
        }
        return jsonResponse({ summary: await editSummary(workspaceId, summaryMatch[1], summaryText, user.id, env, fetchImpl) }, 200, cors);
      }
      if (request.method === "DELETE" && summaryMatch) {
        return jsonResponse({ summary: await deleteSummary(workspaceId, summaryMatch[1], user.id, env, fetchImpl) }, 200, cors);
      }
      if (isMemoriesRoute || claimReviewMatch || conflictResolveMatch) {
        return apiError("feature_retired", "Claim and conflict review is not available.", 410, requestId, cors);
      }
      if (request.method === "GET" && isRetrievalConnectionsRoute) {
        for (const provider of ["chatgpt", "claude", "gemini", "grok", "web_test"]) {
          await ensureRetrievalPermission({ userId: user.id, workspaceId, provider }, env, fetchImpl);
        }
        return jsonResponse({ connections: await listConnections({ userId: user.id, workspaceId }, env, fetchImpl) }, 200, cors);
      }
      if (request.method === "GET" && isSensitivityRoute) {
        return jsonResponse({ settings: await getSensitivitySettings(workspaceId, env, fetchImpl) }, 200, cors);
      }
      if (request.method === "PUT" && isSensitivityRoute) {
        const parsed = await boundedJson(request, 4096);
        if (parsed.error) return apiError("invalid_request", "Sensitivity settings must be valid JSON under 4 KB.", 400, requestId, cors);
        return jsonResponse({ settings: await updateSensitivitySettings(workspaceId, parsed.value, env, fetchImpl) }, 200, cors);
      }
      if (request.method === "PUT" && isRetrievalConnectionsRoute) {
        const parsed = await boundedJson(request, 4096);
        if (parsed.error) return apiError("invalid_request", "Connection settings must be valid JSON under 4 KB.", 400, requestId, cors);
        if (!["chatgpt", "claude", "gemini", "grok"].includes(parsed.value.provider)) return apiError("invalid_provider", "Choose ChatGPT, Claude, Gemini, or Grok.", 422, requestId, cors);
        const connection = await upsertRetrievalPermission({ userId: user.id, workspaceId, provider: parsed.value.provider, readEnabled: parsed.value.readEnabled !== false, writeNotesEnabled: parsed.value.writeNotesEnabled === true }, env, fetchImpl);
        return jsonResponse({ connection }, 200, cors);
      }
      if (request.method === "POST" && isRetrievalTestRoute) {
        const parsed = await boundedJson(request, 4096);
        if (parsed.error) return apiError("invalid_request", "The retrieval test must be valid JSON under 4 KB.", 400, requestId, cors);
        const query = typeof parsed.value.query === "string" ? parsed.value.query.trim() : "";
        if (!query || query.length > 500) return apiError("invalid_query", "Enter a query between 1 and 500 characters.", 422, requestId, cors);
        await ensureRetrievalPermission({ userId: user.id, workspaceId, provider: "web_test" }, env, fetchImpl);
        return jsonResponse(await searchMemory({ userId: user.id, workspaceId, provider: "web_test", query, maxCharacters: 10000, toolName: "memory.web_test" }, env, fetchImpl), 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/v1/conversations") {
        return jsonResponse({ conversations: await listConversations(workspaceId, env, fetchImpl) }, 200, cors);
      }
      if (request.method === "GET" && conversationMatch) {
        const detail = await conversationDetail(workspaceId, conversationMatch[1], env, fetchImpl);
        return detail ? jsonResponse({ conversation: detail }, 200, cors) : apiError("not_found", "Conversation not found.", 404, requestId, cors);
      }
      if (request.method === "GET" && conversationIdentitiesMatch) {
        const identities = await conversationEventIdentities(workspaceId, conversationIdentitiesMatch[1], env, fetchImpl);
        return identities ? jsonResponse(identities, 200, cors) : apiError("not_found", "Conversation not found.", 404, requestId, cors);
      }
      if (request.method === "DELETE" && conversationMatch) {
        const result = await deleteConversation(workspaceId, conversationMatch[1], env, fetchImpl);
        return result ? jsonResponse({ ok: true, deleted: result }, result.cleanupPending ? 202 : 200, cors) : apiError("not_found", "Conversation not found.", 404, requestId, cors);
      }
      if (request.method === "GET" && isSettingsRoute) {
        const settings = await getSummarizerSettings(workspaceId, env, (path, options) => supabaseJson(path, env, fetchImpl, options));
        return jsonResponse({ settings }, 200, cors);
      }
      if (request.method === "PUT" && isSettingsRoute) {
        const declaredLength = Number(request.headers.get("content-length") || 0);
        if (declaredLength > 16384) return apiError("settings_too_large", "Settings exceed the 16 KB limit.", 413, requestId, cors);
        const rawBody = await request.text();
        if (new TextEncoder().encode(rawBody).byteLength > 16384) {
          return apiError("settings_too_large", "Settings exceed the 16 KB limit.", 413, requestId, cors);
        }
        let payload;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return apiError("invalid_json", "The request body must be valid JSON.", 400, requestId, cors);
        }
        const validation = validateSummarizerSettings(payload);
        if (!validation.ok) {
          return apiError("validation_failed", "The summarizer settings are invalid.", 422, requestId, cors, validation.errors);
        }
        const settings = await saveSummarizerSettings(
          workspaceId,
          user.id,
          validation.value,
          env,
          (path, options) => supabaseJson(path, env, fetchImpl, options)
        );
        return jsonResponse({ settings }, 200, cors);
      }
      if (request.method === "POST" && isSummaryRunRoute) {
        const declaredLength = Number(request.headers.get("content-length") || 0);
        if (declaredLength > 2048) return apiError("request_too_large", "The run request exceeds the 2 KB limit.", 413, requestId, cors);
        let payload = {};
        const rawBody = await request.text();
        if (new TextEncoder().encode(rawBody).byteLength > 2048) {
          return apiError("request_too_large", "The run request exceeds the 2 KB limit.", 413, requestId, cors);
        }
        if (rawBody.trim()) {
          try {
            payload = JSON.parse(rawBody);
          } catch {
            return apiError("invalid_json", "The request body must be valid JSON.", 400, requestId, cors);
          }
        }
        const conversationId = payload?.conversationId == null ? null : String(payload.conversationId);
        if (conversationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId)) {
          return apiError("invalid_conversation_id", "conversationId must be a valid UUID.", 422, requestId, cors);
        }
        const result = await runSummarizationCycle({
          workspaceId,
          conversationId,
          reason: "manual"
        }, env, { fetch: fetchImpl });
        if (result.status === "not_configured") {
          return apiError(
            "summarizer_not_configured",
            "Choose a model and save its API key before running a summary.",
            409,
            requestId,
            cors
          );
        }
        return jsonResponse(result, 200, cors);
      }
      return apiError("method_not_allowed", "Method not allowed.", 405, requestId, cors);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "memory_route_failed", requestId, message: error?.message || "Unknown error" }));
      return apiError("memory_operation_failed", "The memory operation could not be completed.", 502, requestId, cors);
    }
  }

  if (request.method !== "POST" || url.pathname !== "/v1/capture/batches") {
    return env.ASSETS ? env.ASSETS.fetch(request) : apiError("not_found", "Route not found.", 404, requestId, cors);
  }

  if (!configured(env)) {
    return apiError("service_not_configured", "The ingestion service is not configured.", 503, requestId, cors);
  }

  let user;
  try {
    user = await authenticate(request, env, fetchImpl);
  } catch {
    return apiError("auth_unavailable", "Authentication is temporarily unavailable.", 503, requestId, cors);
  }
  if (!user) return apiError("unauthorized", "A valid signed-in session is required.", 401, requestId, cors);

  const declaredLength = Number(request.headers.get("content-length") || 0);
  const maxBytes = Number(env.MAX_BATCH_BYTES || captureLimits.defaultMaxBatchBytes);
  if (declaredLength > maxBytes) {
    return apiError("batch_too_large", `The batch exceeds the ${maxBytes}-byte limit.`, 413, requestId, cors);
  }

  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return apiError("invalid_body", "The request body could not be read.", 400, requestId, cors);
  }
  const payloadBytes = new TextEncoder().encode(rawBody).byteLength;
  if (payloadBytes > maxBytes) {
    return apiError("batch_too_large", `The batch exceeds the ${maxBytes}-byte limit.`, 413, requestId, cors);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return apiError("invalid_json", "The request body must be valid JSON.", 400, requestId, cors);
  }

  const validation = validateCaptureBatch(payload);
  if (!validation.ok) {
    return apiError("validation_failed", "The capture batch is invalid.", 422, requestId, cors, validation.errors);
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey && idempotencyKey !== validation.value.batchId) {
    return apiError("idempotency_mismatch", "Idempotency-Key must match batchId.", 409, requestId, cors);
  }

  let filtered;
  try {
    filtered = await omitDeletedConversations(validation.value, env, fetchImpl);
  } catch {
    return apiError("deletion_policy_unavailable", "Deleted-conversation rules could not be checked.", 503, requestId, cors);
  }
  if (filtered.events.length === 0) {
    return jsonResponse({ ok: true, requestId, batchId: filtered.batchId, ignoredDeletedEvents: filtered.omitted }, 200, cors);
  }
  const redacted = redactCaptureBatch(filtered);
  const objectKey = rawObjectKey(redacted.batch);
  const archive = {
    ...redacted.batch,
    ingestion: {
      archiveVersion: redacted.batch.schemaVersion,
      userId: user.id,
      redactionSummary: redacted.summary
    }
  };
  const archiveBody = JSON.stringify(archive);
  const payloadSha256 = await sha256Hex(archiveBody);
  let archiveCreated = false;

  try {
    const existing = await env.RAW_MEMORY.head(objectKey);
    if (existing && existing.customMetadata?.sha256 !== payloadSha256) {
      return apiError("idempotency_conflict", "This batchId was already used for different content.", 409, requestId, cors);
    }
    if (!existing) {
      const stored = await env.RAW_MEMORY.put(objectKey, archiveBody, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          workspaceId: redacted.batch.workspaceId,
          provider: redacted.batch.provider,
          schemaVersion: String(redacted.batch.schemaVersion),
          product: redacted.batch.product,
          surface: redacted.batch.surface,
          batchId: redacted.batch.batchId,
          sha256: payloadSha256
        }
      });
      if (stored) {
        archiveCreated = true;
      } else {
        const concurrent = await env.RAW_MEMORY.head(objectKey);
        if (!concurrent || concurrent.customMetadata?.sha256 !== payloadSha256) {
          return apiError("idempotency_conflict", "This batchId was concurrently used for different content.", 409, requestId, cors);
        }
      }
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "r2_write_failed",
      requestId,
      message: error?.message ?? "Unknown R2 error"
    }));
    return apiError("archive_unavailable", "The raw archive could not be stored. The cursor was not advanced.", 503, requestId, cors);
  }

  let metadataResponse;
  try {
    metadataResponse = await commitMetadata(redacted.batch, {
      userId: user.id,
      rawObjectKey: objectKey,
      payloadSha256,
      payloadBytes: new TextEncoder().encode(archiveBody).byteLength,
      redactionSummary: redacted.summary
    }, env, fetchImpl);
  } catch (error) {
    if (archiveCreated) await env.RAW_MEMORY.delete(objectKey).catch(() => undefined);
    console.error(JSON.stringify({
      level: "error",
      event: "supabase_write_failed",
      requestId,
      message: error?.message ?? "Unknown Supabase error"
    }));
    return apiError("metadata_unavailable", "Metadata could not be stored. The cursor was not advanced.", 503, requestId, cors);
  }

  if (!metadataResponse.ok) {
    if (archiveCreated) await env.RAW_MEMORY.delete(objectKey).catch(() => undefined);
    const denied = metadataResponse.status === 401 || metadataResponse.status === 403;
    return apiError(
      denied ? "workspace_forbidden" : "metadata_rejected",
      denied ? "This account cannot write to the selected workspace." : "The metadata transaction was rejected. The cursor was not advanced.",
      denied ? 403 : 502,
      requestId,
      cors
    );
  }

  const result = await metadataResponse.json();
  try {
    await supabaseJson(
      `ingestion_batches?workspace_id=eq.${encodeURIComponent(redacted.batch.workspaceId)}&batch_id=eq.${encodeURIComponent(redacted.batch.batchId)}`,
      env, fetchImpl,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", prefer: "return=minimal" },
        body: JSON.stringify({ provider_conversation_ids: [...new Set(redacted.batch.events.map((event) => event.conversationId))] })
      }
    );
  } catch {
    // The committed archive remains discoverable through the null index on retry.
    return apiError("archive_index_unavailable", "The archive index could not be saved. Retry this batch before advancing the cursor.", 503, requestId, cors);
  }
  return jsonResponse({
    ok: true,
    requestId,
    batchId: redacted.batch.batchId,
    rawObjectKey: objectKey,
    redactions: redacted.summary,
    result
  }, 200, cors);
}

export const appHandler = {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runSummarizationCycle({ reason: "scheduled" }, env).catch((error) => {
        console.error(JSON.stringify({
          level: "error",
          event: "summarization_cycle_failed",
          cron: controller.cron,
          message: error?.message || "Unknown error"
        }));
      })
    );
    ctx.waitUntil(
      reconcileDeletedArchives(env).catch((error) => {
        console.error(JSON.stringify({
          level: "error",
          event: "archive_reconciliation_cycle_failed",
          cron: controller.cron,
          message: error?.message || "Unknown error"
        }));
      })
    );
  }
};

export default appHandler;
