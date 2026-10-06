const SUPABASE_URL = "https://zwpzmmfpgjaaikacoqas.supabase.co";
const SUPABASE_KEY = "sb_publishable_mEtfpCKWHYDKARfWNNO5BA_ouWQWmfN";
const WORKER_URL = "https://shared-memory-ingestion.mufaddal-m25.workers.dev";
const EXTENSION_ID = "hooccdjkfnlghchnpomhijgdcblkgllj";
const $ = (id) => document.getElementById(id);
function setOriginalChatLink(link, sourceUrl) {
  const valid = typeof sourceUrl === "string" && /^https:\/\//i.test(sourceUrl);
  link.hidden = !valid;
  if (valid) link.href = sourceUrl;
  else link.removeAttribute("href");
}
const { messageTime, sort: sortedTranscriptEvents } = globalThis.SherryTranscriptOrder;
const isPreview = new URLSearchParams(location.search).get("preview") === "1";
const LOCAL_APP_HOSTS = new Set(["localhost", "127.0.0.1"]);
const API_BASE = location.protocol === "file:" || LOCAL_APP_HOSTS.has(location.hostname) ? WORKER_URL : "";
let session = JSON.parse(localStorage.getItem("memory_session") || "null");
let workspace = null;
let conversations = [];
let selected = null;
let exportPayload = null;
let summarizerSettings = null;
let summaries = null;
let memoryData = null;
let dashboardData = null;
let diagnosticsData = null;
let extensionStatusData = null;
let pendingClaudeImport = null;
let selectedSummary = null;
let retrievalConnections = null;
let sensitivitySettings = null;
let personalMemoryEntries = [];
let personalMemoryCustomCategories = [];
let bootDataAlerts = [];
let reviewMode = "all";
const deferredConflictIds = new Set();
let memoryGraph = null;
let mapMatchId = null;
let refreshingChatMemory = false;
let selectingChats = false;
let deletingChats = false;
const selectedChatIds = new Set();
let bulkDeleteTarget = null;
const CHAT_SORT_OPTIONS = new Set(["recent", "oldest", "title-asc", "title-desc", "most-messages"]);
let chatSort = CHAT_SORT_OPTIONS.has(localStorage.getItem("sherry_chat_sort")) ? localStorage.getItem("sherry_chat_sort") : "recent";
let chatView = localStorage.getItem("sherry_chat_view") === "table" ? "table" : "grid";
let conversationFilters = { query: "", provider: "all", device: "all", date: "all", dateFrom: "", dateTo: "", artifacts: "all" };
let conflictFilters = { query: "", sort: "newest", page: 1, pageSize: 10 };

const previewConversations = [
  { id: "preview-1", provider: "chatgpt", title: "Memory platform — product direction", last_captured_at: new Date(Date.now() - 36e5).toISOString(), conversation_events: [{ count: 28 }], events: [{ role: "user", text_content: "I want one memory layer that works across the AI tools I already use." }, { role: "assistant", text_content: "The product can separate capture, durable memory, retrieval, and provider permissions." }] },
  { id: "preview-2", provider: "claude", title: "Detailed design feedback preferences", last_captured_at: new Date(Date.now() - 864e5).toISOString(), conversation_events: [{ count: 14 }], events: [{ role: "user", text_content: "I prefer detailed design feedback with the reasoning explained clearly." }, { role: "assistant", text_content: "I will retain that as a reusable communication preference." }] },
  { id: "preview-3", provider: "gemini", title: "Research synthesis for shared memory", last_captured_at: new Date(Date.now() - 2 * 864e5).toISOString(), conversation_events: [{ count: 19 }], events: [{ role: "user", text_content: "Compare approaches to user-owned cloud memory." }, { role: "assistant", text_content: "A fast indexed layer can sync with user-controlled export storage." }] },
  { id: "preview-4", provider: "chatgpt", title: "Memory Test 4", last_captured_at: new Date(Date.now() - 3 * 864e5).toISOString(), conversation_events: [{ count: 11 }], events: [{ role: "user", text_content: "Project updates should be short bullet points." }, { role: "assistant", text_content: "Understood." }] },
  { id: "preview-5", provider: "claude", title: "Gate 8 interface review", last_captured_at: new Date(Date.now() - 5 * 864e5).toISOString(), conversation_events: [{ count: 22 }], events: [{ role: "user", text_content: "The interface should make source evidence easy to reach." }, { role: "assistant", text_content: "Each memory can link back to its exact conversation." }] },
  { id: "preview-6", provider: "gemini", title: "Capture policy decisions", last_captured_at: new Date(Date.now() - 7 * 864e5).toISOString(), conversation_events: [{ count: 17 }], events: [{ role: "user", text_content: "Attachments and temporary chats should stay off by default." }, { role: "assistant", text_content: "Those defaults reduce storage and accidental capture." }] }
];

const previewSummary = {
  id: "preview-summary", version: 2, status: "active", provider: "anthropic", model: "claude-sonnet-5", total_tokens: 1240,
  summary_text: "The user is building a shared AI memory platform, prefers detailed design feedback, and wants project updates delivered as short bullet points.",
  pendingClaimCount: 2, topics: ["Shared memory", "Design feedback"], relatedClaims: [{ id: "preview-claim-1" }, { id: "preview-claim-2" }],
  conversation: { id: "preview-1", provider: "chatgpt", title: "Memory platform — product direction", canonical_chat_url: "#" },
  created_at: new Date().toISOString(), exact_cost_usd: 0.0021,
  events: [{ role: "user", inclusion_type: "new", included_revision: 1, text_content: "I prefer detailed design feedback." }, { role: "user", inclusion_type: "new", included_revision: 1, text_content: "Project updates should be short bullet points." }],
  history: [{ version: 2, status: "active" }, { version: 1, status: "superseded" }]
};

const previewMemoryData = {
  claims: [
    { id: "preview-claim-1", display_text: "User prefers detailed design feedback", status: "confirmed", confidence: .98, reviewHistory: [{ decision: "yes" }], evidence: [{ event: { role: "user", text_content: "I prefer detailed design feedback." } }] },
    { id: "preview-claim-2", display_text: "User prefers project updates as short bullet points", status: "provisional", confidence: .91, reviewHistory: [], evidence: [{ event: { role: "user", text_content: "Project updates should be short bullet points." } }] },
    { id: "preview-claim-3", display_text: "User is building a shared AI memory platform", status: "provisional", confidence: .94, reviewHistory: [], evidence: [{ event: { role: "user", text_content: "I am building a shared AI memory platform." } }] }
  ],
  conflicts: [{ id: "preview-conflict", status: "unresolved", leftClaim: { display_text: "User is working on an app called Memory" }, rightClaim: { display_text: "User is building a shared AI memory platform" } }]
};

function providerLabel(provider) {
  return ({ chatgpt: "ChatGPT", codex: "Codex", claude: "Claude", claude_code: "Claude Code", gemini: "Gemini", antigravity: "Antigravity", grok: "Grok", openai: "OpenAI", anthropic: "Claude", google: "Gemini", generic: "Other AI" }[provider] || provider || "Unknown");
}

function platformLabel(platform) {
  return ({ web: "Web", desktop: "Desktop", cli: "Terminal", ide: "IDE", android: "Android", unknown: "Unknown platform" }[platform] || platform || "Unknown platform");
}

function previewDashboardMetrics() {
  const chatsByTool = new Map();
  const messagesByTool = new Map();
  const pairs = new Map();
  let totalMessages = 0;
  for (const conversation of conversations) {
    const tool = conversation.product || conversation.provider || "unknown";
    const platform = conversation.primary_surface || "web";
    const messages = Number(conversation.conversation_events?.[0]?.count || 0);
    chatsByTool.set(tool, (chatsByTool.get(tool) || 0) + 1);
    messagesByTool.set(tool, (messagesByTool.get(tool) || 0) + messages);
    pairs.set(`${platform}::${tool}`, (pairs.get(`${platform}::${tool}`) || 0) + 1);
    totalMessages += messages;
  }
  const breakdown = (map, keyName) => [...map.entries()]
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((a, b) => b.count - a.count || a[keyName].localeCompare(b[keyName]));
  return {
    generatedAt: new Date().toISOString(),
    chats: { total: conversations.length, totalMessages, byTool: breakdown(chatsByTool, "tool") },
    messagesByTool: breakdown(messagesByTool, "tool"),
    platformToolPairs: breakdown(pairs, "pair").map(({ pair, count }) => {
      const [platform, tool] = pair.split("::");
      return { platform, tool, count };
    }),
    useCases: (previewSummary.topics || []).map((name) => ({ name, count: 1, tools: [{ tool: previewSummary.conversation.provider, count: 1 }] })),
    summaryCoverage: { summarizedChats: 1, capturedChats: conversations.length },
    retrieval: { total: 0, byTool: [], mostUsedMemories: [] },
    artifacts: { indexed: false, total: null, byType: [], message: "Artifact metadata is not indexed yet. Sherry will show types here once capture supports it." }
  };
}

function dashboardFallbackFromConversations(items = []) {
  const chatsByTool = new Map();
  const messagesByTool = new Map();
  const pairs = new Map();
  let totalMessages = 0;
  for (const conversation of items) {
    const tool = conversation.product || conversation.provider || "unknown";
    const platform = conversation.primary_surface || "web";
    const messages = Number(conversation.conversation_events?.[0]?.count || 0);
    chatsByTool.set(tool, (chatsByTool.get(tool) || 0) + 1);
    messagesByTool.set(tool, (messagesByTool.get(tool) || 0) + messages);
    pairs.set(`${platform}::${tool}`, (pairs.get(`${platform}::${tool}`) || 0) + 1);
    totalMessages += messages;
  }
  const breakdown = (map, keyName) => [...map.entries()].map(([key, count]) => ({ [keyName]: key, count }));
  return {
    generatedAt: new Date().toISOString(),
    chats: { total: items.length, totalMessages, byTool: breakdown(chatsByTool, "tool") },
    messagesByTool: breakdown(messagesByTool, "tool"),
    platformToolPairs: breakdown(pairs, "pair").map(({ pair, count }) => {
      const [platform, tool] = pair.split("::");
      return { platform, tool, count };
    }),
    useCases: [],
    summaryCoverage: { summarizedChats: 0, capturedChats: items.length },
    retrieval: { total: 0, byTool: [], mostUsedMemories: [] },
    artifacts: { indexed: false, total: null, byType: [], message: "Artifact metadata is not available yet." }
  };
}

function dashboardEmpty(container, message) {
  const empty = document.createElement("div");
  empty.className = "dashboard-empty-state";
  empty.textContent = message;
  container.replaceChildren(empty);
}

function renderMetricList(id, items, labelFor, valueFor, emptyMessage, ranked = false) {
  const container = $(id);
  container.classList.toggle("metric-list-ranked", ranked);
  if (!items.length) return dashboardEmpty(container, emptyMessage);
  container.replaceChildren(...items.map((item) => {
    const row = document.createElement("div");
    row.className = "metric-list-row";
    const label = document.createElement("span");
    label.textContent = labelFor(item);
    label.title = label.textContent;
    const value = document.createElement("strong");
    value.textContent = valueFor(item);
    row.append(label, value);
    return row;
  }));
}

function renderMetricBars(id, items, labelFor, valueFor, emptyMessage) {
  const container = $(id);
  if (!items.length) return dashboardEmpty(container, emptyMessage);
  const max = Math.max(...items.map((item) => Number(item.count) || 0), 1);
  container.replaceChildren(...items.slice(0, 5).map((item) => {
    const row = document.createElement("div");
    row.className = "metric-bar-row";
    const copy = document.createElement("div");
    copy.className = "metric-bar-copy";
    const label = document.createElement("span");
    label.textContent = labelFor(item);
    const value = document.createElement("strong");
    value.textContent = valueFor(item);
    const track = document.createElement("span");
    track.className = "metric-track";
    const bar = document.createElement("span");
    bar.style.width = `${Math.round(((Number(item.count) || 0) / max) * 100)}%`;
    track.append(bar);
    copy.append(label, value);
    row.append(copy, track);
    return row;
  }));
}

function renderDashboard() {
  if (!dashboardData) return;
  const chats = dashboardData.chats || { total: 0, totalMessages: 0, byTool: [] };
  const toolMix = chats.byTool || [];
  $("dashboardChatCount").textContent = String(chats.total || 0);
  renderMetricList(
    "dashboardChatBreakdown",
    toolMix,
    (item) => providerLabel(item.tool),
    (item) => `${item.count} chat${item.count === 1 ? "" : "s"}`,
    "No captured conversations yet."
  );
  renderMetricList(
    "dashboardMemoryUsage",
    dashboardData.retrieval?.mostUsedMemories || [],
    (item) => item.label,
    (item) => `${item.count} recall${item.count === 1 ? "" : "s"}`,
    isPreview ? "Retrieval history is not included in preview data." : "No memories have been recalled by an AI tool yet.",
    true
  );
  renderMetricBars(
    "dashboardToolMix",
    toolMix,
    (item) => providerLabel(item.tool),
    (item) => `${Math.round((item.count / Math.max(chats.total, 1)) * 100)}%`,
    "Tool usage appears after the first captured conversation."
  );
  renderMetricBars(
    "dashboardUseCases",
    dashboardData.useCases || [],
    (item) => item.name,
    (item) => `${item.count} summar${item.count === 1 ? "y" : "ies"}`,
    "Use cases appear after active conversation summaries identify topics."
  );
  const coverage = dashboardData.summaryCoverage || { summarizedChats: summaries?.length || 0, capturedChats: chats.total || 0 };
  $("dashboardUseCaseCoverage").textContent = `Based on ${coverage.summarizedChats} of ${coverage.capturedChats} captured chats with active summaries.`;
  renderMetricList(
    "dashboardUseCaseTools",
    (dashboardData.useCases || []).slice(0, 5),
    (item) => item.name,
    (item) => providerLabel(item.tools?.[0]?.tool),
    "No summarized use cases are available yet."
  );
  renderMetricBars(
    "dashboardRetrievalUsage",
    dashboardData.retrieval?.byTool || [],
    (item) => providerLabel(item.tool),
    (item) => `${item.count} lookup${item.count === 1 ? "" : "s"}`,
    isPreview ? "Live AI lookup history is not included in preview data." : "No AI tool has searched your memory yet."
  );

  const platform = $("dashboardPlatformMix");
  const pairs = dashboardData.platformToolPairs || [];
  if (!pairs.length) {
    dashboardEmpty(platform, "Platform usage appears after the first captured conversation.");
  } else {
    const primary = document.createElement("div");
    primary.className = "platform-summary-main";
    const title = document.createElement("strong");
    title.textContent = providerLabel(pairs[0].tool);
    const copy = document.createElement("span");
    copy.textContent = `${platformLabel(pairs[0].platform)} · ${pairs[0].count} conversation${pairs[0].count === 1 ? "" : "s"}`;
    primary.append(title, copy);
    platform.replaceChildren(primary);
    if (pairs.length > 1) {
      const secondary = document.createElement("small");
      secondary.textContent = `Next: ${providerLabel(pairs[1].tool)} on ${platformLabel(pairs[1].platform)} (${pairs[1].count})`;
      platform.append(secondary);
    }
  }

  const artifacts = $("dashboardArtifacts");
  if (dashboardData.artifacts?.indexed && dashboardData.artifacts.byType?.length) {
    artifacts.className = "metric-list";
    renderMetricList("dashboardArtifacts", dashboardData.artifacts.byType, (item) => item.type, (item) => String(item.count), "No artifacts captured yet.");
  } else {
    artifacts.className = "dashboard-empty";
    const title = document.createElement("strong");
    title.textContent = "No artifact data yet";
    const copy = document.createElement("p");
    copy.textContent = dashboardData.artifacts?.message || "Artifact capture has not recorded any typed artifacts.";
    artifacts.replaceChildren(title, copy);
  }
}

function metricEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "metric-detail-empty";
  const title = document.createElement("strong");
  title.textContent = "No live data yet";
  const copy = document.createElement("p");
  copy.textContent = message;
  empty.append(title, copy);
  return empty;
}

function metricStat(value, label) {
  const item = document.createElement("div");
  const number = document.createElement("strong");
  number.textContent = String(value);
  const copy = document.createElement("span");
  copy.textContent = label;
  item.append(number, copy);
  return item;
}

function metricRows(items, columns, options = {}) {
  const list = document.createElement("div");
  list.className = "metric-detail-list";
  for (const item of items) {
    const selectable = Boolean(options.onSelect && (!options.selectable || options.selectable(item)));
    const row = selectable ? document.createElement("button") : document.createElement("div");
    row.className = "metric-detail-row";
    if (selectable) {
      row.type = "button";
      row.onclick = () => options.onSelect(item);
    }
    for (const column of columns) {
      const cell = document.createElement(column.strong ? "strong" : "span");
      cell.textContent = column.value(item);
      if (column.muted) cell.className = "muted";
      row.append(cell);
    }
    if (selectable) {
      const arrow = document.createElement("span");
      arrow.className = "metric-detail-arrow";
      arrow.textContent = "Open ↗";
      row.append(arrow);
    }
    list.append(row);
  }
  return list;
}

function setMetricDialog(kicker, title, description, summaryItems, bodyNodes) {
  $("metricDialogKicker").textContent = kicker;
  $("metricDialogTitle").textContent = title;
  $("metricDialogDescription").textContent = description;
  $("metricDialogSummary").replaceChildren(...summaryItems);
  $("metricDialogBody").replaceChildren(...bodyNodes);
  $("metricDialog").showModal();
}

function openConversationFromMetric(id, options = {}) {
  $("metricDialog").close();
  openConversation(id, options);
}

const backdropPointerStarts = new WeakMap();

function rememberDialogBackdropPointer(event) {
  const dialog = event.currentTarget;
  const bounds = dialog.getBoundingClientRect();
  const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  backdropPointerStarts.set(dialog, event.target === dialog && outside);
}

function closeDialogFromBackdrop(event) {
  const dialog = event.currentTarget;
  const startedOutside = backdropPointerStarts.get(dialog);
  backdropPointerStarts.delete(dialog);
  if (!startedOutside || event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  const endedOutside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (endedOutside) dialog.close();
}

function renderPipelineDetails() {
  const stages = diagnosticsData?.stages || [];
  const body = [];
  if (stages.length) body.push(metricRows(stages, [
    { strong: true, value: (item) => item.label },
    { value: (item) => item.detail },
    { strong: true, value: (item) => item.status === "ready" ? "Ready" : item.status === "error" ? "Needs attention" : "Waiting" }
  ]));
  const failures = diagnosticsData?.failures || [];
  if (failures.length) {
    if (failures.some((failure) => failure.errorCode === "provider_authentication_failed")) {
      const callout = document.createElement("div");
      callout.className = "metric-action-callout";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = "The saved summarization API key needs to be replaced";
      const detail = document.createElement("p");
      detail.textContent = "Sherry cannot repair a rejected provider credential. Replace it once, then run the next eligible summary from Settings.";
      copy.append(title, detail);
      const action = document.createElement("button");
      action.className = "secondary";
      action.type = "button";
      action.textContent = "Update API key";
      action.onclick = () => {
        $("metricDialog").close();
        showView("settings");
        requestAnimationFrame(() => $("summarizerForm").scrollIntoView({ block: "start" }));
      };
      callout.append(copy, action);
      body.push(callout);
    }
    const heading = document.createElement("div");
    heading.className = "metric-detail-section-head";
    heading.innerHTML = "<p class=\"kicker\">SUMMARIZATION FAILURES</p><h3>Conversations that need attention</h3>";
    body.push(heading, metricRows(failures, [
      { strong: true, value: (item) => item.conversationTitle },
      { value: (item) => `${providerLabel(item.conversationProvider)} · ${item.provider || "provider"} / ${item.model || "model not recorded"}` },
      { value: (item) => item.errorDetail || item.errorCode }
    ], { onSelect: (item) => openConversationFromMetric(item.conversationId) }));
  }
  if (!body.length) body.push(metricEmpty("Pipeline status is still loading. Refresh Diagnostics and try again."));
  setMetricDialog(
    "PIPELINE HEALTH",
    "How memory moves through Sherry",
    "Each stage reports live cloud evidence. Open a failed conversation to inspect its source and summary state.",
    [metricStat(stages.filter((item) => item.status === "ready").length, "stages ready"), metricStat(failures.length, "summaries needing attention"), metricStat(diagnosticsData?.sanitizedCount || 0, "sanitized summaries")],
    body
  );
}

function openMetricDialog(metric) {
  if (!dashboardData) return;
  const chats = dashboardData.chats || { total: 0, totalMessages: 0, byTool: [] };
  const empty = (message) => [metricEmpty(message)];
  if (metric === "pipeline") return renderPipelineDetails();
  if (metric === "chats") {
    const items = conversations || [];
    return setMetricDialog("TOTAL CHATS", "Captured conversations", "Every chat currently stored in this workspace, with its source AI and message count.", [metricStat(chats.total || 0, "conversations"), metricStat(chats.totalMessages || 0, "messages"), metricStat(chats.byTool?.length || 0, "AI tools")], items.length ? [metricRows(items, [
      { strong: true, value: (item) => item.title || "Untitled conversation" },
      { value: (item) => providerLabel(item.product || item.provider) },
      { value: (item) => `${Number(item.conversation_events?.[0]?.count || item.events?.length || 0)} messages · ${conversationActivityLabel(item)}` }
    ], { onSelect: (item) => openConversationFromMetric(item.id) })] : empty("Captured conversations will appear here after the extension uploads them."));
  }
  if (metric === "memories") {
    const items = dashboardData.retrieval?.mostUsedMemories || [];
    return setMetricDialog("MOST USED MEMORIES", "Memories recalled most often", "Each row is a distinct memory returned by a successful AI search. Excerpts show the retrieved text and can jump to its exact source message.", [metricStat(items.length, "memories recalled"), metricStat(items.reduce((sum, item) => sum + Number(item.count || 0), 0), "total recalls")], items.length ? [metricRows(items, [
      { strong: true, value: (item) => item.excerpt ? `“${truncateText(item.excerpt, 180)}”` : item.label },
      { value: (item) => item.sourceTitle ? `${providerLabel(item.sourceProvider)} · ${item.sourceTitle} · excerpt ${item.id}` : item.type.replaceAll("_", " ") },
      { strong: true, value: (item) => `${item.count} recall${item.count === 1 ? "" : "s"}` }
    ], { selectable: (item) => Boolean(item.conversationId), onSelect: (item) => openConversationFromMetric(item.conversationId, { sourceEventId: item.sourceEventId }) })] : empty("A memory will appear after a connected AI successfully retrieves it."));
  }
  if (metric === "tool-mix") {
    const items = chats.byTool || [];
    return setMetricDialog("AI TOOL MIX", "Conversation activity by AI tool", "Conversation and message totals come directly from captured chats.", [metricStat(chats.total || 0, "conversations"), metricStat(chats.totalMessages || 0, "messages")], items.length ? [metricRows(items, [
      { strong: true, value: (item) => providerLabel(item.tool) },
      { value: (item) => `${item.count} conversation${item.count === 1 ? "" : "s"}` },
      { value: (item) => `${dashboardData.messagesByTool?.find((entry) => entry.tool === item.tool)?.count || 0} messages` }
    ])] : empty("Tool activity appears after the first captured conversation."));
  }
  if (metric === "use-cases" || metric === "use-case-tools") {
    const items = dashboardData.useCases || [];
    const toolFocused = metric === "use-case-tools";
    return setMetricDialog(toolFocused ? "TOOL BY USE CASE" : "AI USE CASES", toolFocused ? "Which AI you use for each use case" : "What you use AI for", "Use cases are topics found in active conversation summaries; they do not yet represent every captured chat.", [metricStat(items.length, "identified use cases"), metricStat(dashboardData.summaryCoverage?.summarizedChats || 0, `of ${dashboardData.summaryCoverage?.capturedChats || chats.total || 0} chats summarized`)], items.length ? [metricRows(items, [
      { strong: true, value: (item) => item.name },
      { value: (item) => `${item.count} summar${item.count === 1 ? "y" : "ies"}` },
      { value: (item) => (item.tools || []).map((entry) => `${providerLabel(entry.tool)} (${entry.count})`).join(", ") || "No tool recorded" }
    ])] : empty("Use cases appear after summarization identifies topics in your captured chats."));
  }
  if (metric === "retrieval") {
    const items = dashboardData.retrieval?.byTool || [];
    return setMetricDialog("MEMORY RETRIEVAL BY AI", "Successful memory searches by AI", "A lookup is counted only when a connected AI tool searches Sherry and receives memory results. Dashboard tests are excluded.", [metricStat(dashboardData.retrieval?.total || 0, "successful lookups"), metricStat(items.length, "AI tools")], items.length ? [metricRows(items, [
      { strong: true, value: (item) => providerLabel(item.tool) },
      { value: (item) => "Authenticated memory.search calls" },
      { strong: true, value: (item) => `${item.count} lookup${item.count === 1 ? "" : "s"}` }
    ])] : empty("No connected AI tool has searched your memory yet."));
  }
  if (metric === "platforms") {
    const items = dashboardData.platformToolPairs || [];
    return setMetricDialog("TOP PLATFORM", "Platforms and AI tools used most", "A platform is where a captured conversation happened, such as web, desktop, terminal, or IDE.", [metricStat(items.reduce((sum, item) => sum + item.count, 0), "captured conversations"), metricStat(items.length, "platform and tool pairs")], items.length ? [metricRows(items, [
      { strong: true, value: (item) => providerLabel(item.tool) },
      { value: (item) => platformLabel(item.platform) },
      { strong: true, value: (item) => `${item.count} conversation${item.count === 1 ? "" : "s"}` }
    ])] : empty("Platform activity appears after the first captured conversation."));
  }
  const artifacts = dashboardData.artifacts || {};
  setMetricDialog("ARTIFACTS", "Created artifacts by type", "Artifacts are files or structured outputs attached to captured conversations. This metric stays empty until capture records typed artifact metadata.", [metricStat(artifacts.total ?? 0, "indexed artifacts"), metricStat(artifacts.byType?.length || 0, "artifact types")], artifacts.indexed && artifacts.byType?.length ? [metricRows(artifacts.byType, [{ strong: true, value: (item) => item.type }, { strong: true, value: (item) => String(item.count) }])] : empty(artifacts.message || "No artifact metadata has been indexed yet."));
}

function providerIcon(provider) {
  const key = ({ openai: "chatgpt", anthropic: "claude", google: "gemini", xai: "grok" }[provider] || provider || "unknown");
  const icons = {
    chatgpt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
    claude: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
    gemini: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/></svg>',
    grok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 5 14 14M19 5 5 19"/></svg>'
  };
  const icon = document.createElement("span");
  icon.className = "provider provider-icon";
  icon.title = providerLabel(provider);
  icon.setAttribute("aria-label", providerLabel(provider));
  icon.innerHTML = icons[key] || '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/></svg>';
  return icon;
}

function formatCompactDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const month = date.toLocaleDateString("en-US", { month: "short" });
  return `${date.getDate()} ${month} '${String(date.getFullYear()).slice(-2)}`;
}

function formatDateTime(value) {
  if (!value) return "Time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function conversationActivityAt(conversation) {
  return conversation?.last_activity_at || conversation?.last_captured_at || conversation?.first_captured_at;
}

function conversationActivityLabel(conversation) {
  const basis = conversation?.last_activity_basis;
  const label = basis === "source_message" ? "Last message" : basis === "first_captured_message" ? "Latest new content captured" : "Last synced";
  return `${label} ${formatDateTime(conversationActivityAt(conversation))}`;
}

function isTransientTranscriptEvent(event) {
  if (event?.role !== "assistant") return false;
  return /^(?:(?:chatgpt|claude|gemini)\s+said:\s*)?thinking(?:\.{3}|…)?$/i.test(String(event.text_content || "").trim());
}

function truncateText(value, length = 180) {
  const text = String(value || "").replaceAll(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

function renderSystemAlerts(data) {
  const container = $("systemAlerts");
  const alerts = [...bootDataAlerts];
  const health = $("headerHealth");
  const diagnosticButton = $("openDiagnostics");
  if (health) {
    health.className = `health-badge ${alerts.some((alert) => alert.severity === "error") ? "health-error" : alerts.length ? "health-warning" : ""}`;
    health.innerHTML = `<span class="health-dot"></span>${alerts.some((alert) => alert.severity === "error") ? "Action needed" : alerts.length ? "Review status" : "All systems healthy"}`;
  }
  if (diagnosticButton) diagnosticButton.classList.toggle("hidden", alerts.length === 0);
  container.classList.toggle("hidden", alerts.length === 0);
  container.replaceChildren(...alerts.map((alert) => {
    const item = document.createElement("article");
    item.className = `system-alert ${alert.severity || "warning"}`;
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = alert.title;
    const message = document.createElement("p");
    message.textContent = alert.message;
    const action = document.createElement("small");
    action.textContent = alert.action || "";
    copy.append(title, message, action);
    item.append(copy);
    return item;
  }));
}

function renderDiagnostics(data) {
  diagnosticsData = data;
  const stages = data.stages || [];
  $("diagnosticsPipeline").replaceChildren(...stages.map((stage, index) => {
    const item = document.createElement("article");
    item.className = "pipeline-step";
    item.dataset.state = stage.status;
    const number = document.createElement("span");
    number.className = "pipeline-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = stage.label;
    const detail = document.createElement("p");
    detail.textContent = stage.detail;
    copy.append(title, detail);
    const state = document.createElement("span");
    state.className = `status-pill ${stage.status === "ready" ? "confirmed" : stage.status === "error" ? "rejected" : "provisional"}`;
    state.textContent = stage.status === "ready" ? "Ready" : stage.status === "error" ? "Needs attention" : "Waiting";
    item.append(number, copy, state);
    return item;
  }));
  const failures = data.failures || [];
  $("diagnosticsFailures").replaceChildren(...failures.map((failure) => {
    const item = document.createElement("button");
    item.className = "diagnostic-failure";
    item.type = "button";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = failure.conversationTitle;
    const detail = document.createElement("small");
    detail.textContent = `${providerLabel(failure.conversationProvider)} · ${failure.provider || "provider"} / ${failure.model || "model not recorded"} · ${failure.errorDetail || failure.errorCode}`;
    copy.append(title, detail);
    const action = document.createElement("span");
    action.textContent = "Inspect conversation ↗";
    item.append(copy, action);
    item.onclick = () => openConversation(failure.conversationId);
    return item;
  }));
  $("diagnosticsStatus").textContent = failures.length
    ? `${failures.length} conversation${failures.length === 1 ? " has" : "s have"} a failed latest summary. Open one above to inspect the source and provider response.`
    : data.sanitizedCount
      ? `${data.sanitizedCount} summary output${data.sanitizedCount === 1 ? " was" : "s were"} saved after unsupported claims were removed. No active failure remains.`
      : "No active cloud processing issue was reported.";
}

function previewDiagnostics() {
  return {
    status: "healthy",
    alerts: [],
    failures: [],
    sanitizedCount: 0,
    stages: [
      { id: "capture", label: "Capture", status: "ready", detail: "Preview conversations are available." },
      { id: "upload", label: "Upload", status: "ready", detail: "Preview upload state is ready for interface review." },
      { id: "index", label: "Index", status: "ready", detail: "Preview content can be searched." },
      { id: "summarize", label: "Summarize", status: "ready", detail: "No preview summarization failures." },
      { id: "retrieve", label: "Retrieve", status: "ready", detail: "Preview retrieval is available." }
    ]
  };
}

async function loadDiagnostics() {
  if (!workspace) return;
  if (isPreview) {
    const data = previewDiagnostics();
    renderSystemAlerts(data);
    renderDiagnostics(data);
    $("dashboardHealthCount").textContent = "5/5";
    $("dashboardHealthLabel").textContent = "systems ready";
    if ($("dashboardProcessingState")) $("dashboardProcessingState").textContent = "Capture, indexing, and retrieval are healthy";
    if ($("diagnosticsStatus")) $("diagnosticsStatus").textContent = "Preview status: all five stages are ready for interface review.";
    return data;
  }
  try {
    const data = await api(`/v1/diagnostics/status?workspaceId=${workspace.id}`);
    renderSystemAlerts(data);
    renderDiagnostics(data);
    $("dashboardHealthCount").textContent = data.status === "healthy" ? "5/5" : "—";
    $("dashboardHealthLabel").textContent = data.status === "healthy" ? "systems ready" : "status needs review";
    const activeAlerts = (data.alerts || []).filter((alert) => alert.id !== "summarization-sanitized");
    if ($("dashboardProcessingState")) $("dashboardProcessingState").textContent = activeAlerts.length ? `${activeAlerts.length} item${activeAlerts.length === 1 ? "" : "s"} need attention` : "Everything is running normally";
    if ($("diagnosticsStatus")) $("diagnosticsStatus").textContent = data.alerts?.length ? data.alerts.map((alert) => `${alert.title}: ${alert.message}`).join(" ") : "No active capture or processing issues were reported.";
    return data;
  } catch (error) {
    console.error("Diagnostics status failed", error);
    const data = { alerts: [{
      severity: "error",
      title: "System status could not be checked",
      message: "Your stored memory is still available, but Sherry could not verify that background processing is healthy.",
      action: "Reload the page. If this persists, capture the time shown and check Diagnostics."
    }] };
    renderSystemAlerts(data);
    renderDiagnostics({ ...data, failures: [], stages: [] });
    $("dashboardHealthCount").textContent = "—";
    $("dashboardHealthLabel").textContent = "status unavailable";
    if ($("dashboardProcessingState")) $("dashboardProcessingState").textContent = "Status check unavailable";
    if ($("diagnosticsStatus")) $("diagnosticsStatus").textContent = data.alerts[0].message;
    return data;
  }
}

async function refreshSession() {
  if (!session?.refresh_token) return false;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh_token })
  });
  if (!response.ok) return false;
  session = await response.json();
  localStorage.setItem("memory_session", JSON.stringify(session));
  return true;
}

async function supabase(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, { ...options, headers: { apikey: SUPABASE_KEY, ...(session?.access_token ? { authorization: `Bearer ${session.access_token}` } : {}), "content-type": "application/json", ...options.headers } });
  if (!response.ok) { const error=new Error((await response.json().catch(() => ({}))).msg || "Request failed");error.status=response.status;throw error; }
  return response.status === 204 ? null : response.json();
}
async function api(path, options = {}) {
  const request = () => fetch(`${API_BASE}${path}`, { ...options, headers: { authorization: `Bearer ${session?.access_token || ""}`, ...options.headers } });
  let response = await request();
  if (response.status === 401 && await refreshSession().catch(() => false)) response = await request();
  if (!response.ok) {
    const message = (await response.json().catch(() => ({}))).error?.message;
    const error = new Error(message || (response.status === 401 ? "Session expired. Please sign in again." : "Request failed"));
    error.status = response.status;
    throw error;
  }
  return response.json();
}
function download(name, value) { const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"})); const a=document.createElement("a"); a.href=url;a.download=name;a.hidden=true;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000); }
function showAuth() { $("auth").classList.remove("hidden"); $("app").classList.add("hidden"); $("signOut").classList.add("hidden"); $("primaryNav").classList.add("hidden"); }
function setSidebarCollapsed(collapsed) {
  $("shell").classList.toggle("sidebar-collapsed", collapsed);
  $("sidebarToggle").setAttribute("aria-expanded", String(!collapsed));
  $("sidebarToggle").setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  $("sidebarToggle").dataset.tooltip = collapsed ? "Expand sidebar" : "Collapse sidebar";
  localStorage.setItem("sherry_sidebar_collapsed", String(collapsed));
  if (memoryGraph) requestAnimationFrame(() => memoryGraph.resize());
}
function initialViewFromHash() {
  const hash = location.hash.slice(1);
  if (["dashboard", "memory", "summaries", "connected", "diagnostics", "settings"].includes(hash)) return hash;
  if (["summarizerForm", "retrieval-settings", "account-settings"].includes(hash)) return "settings";
  return "dashboard";
}
function showView(name) {
  if (name === "review") name = "dashboard";
  const showDashboard = name === "dashboard";
  const showSettings = name === "settings";
  const showSummaries = name === "summaries";
  const showConversations = name === "memory";
  const showConnected = name === "connected";
  const showDiagnostics = name === "diagnostics";
  $("dashboardView").classList.toggle("hidden", !showDashboard);
  $("memoryView").classList.toggle("hidden", !showConversations);
  $("summariesView").classList.toggle("hidden", !showSummaries);
  $("reviewView").classList.add("hidden");
  $("connectedView").classList.toggle("hidden", !showConnected);
  $("settingsView").classList.toggle("hidden", !showSettings);
  $("diagnosticsView").classList.toggle("hidden", !showDiagnostics);
  $("memoryNav").classList.toggle("active", showConversations);
  $("summariesNav").classList.toggle("active", showSummaries);
  $("connectedNav").classList.toggle("active", showConnected);
  $("diagnosticsNav").classList.toggle("active", showDiagnostics);
  $("settingsNav").classList.remove("active");
  $("dashboardNav").classList.toggle("active", showDashboard);
  $("pageTitle").textContent = showDashboard ? "Dashboard" : showSummaries ? "Personal Memory" : showConnected ? "Connected Conversations" : showSettings ? "Settings" : showDiagnostics ? "Diagnostics" : "Chat Memory";
  if (showSummaries) renderPersonalMemoryCategories();
  if (showSettings && !summarizerSettings) loadSettings();
  if (showSettings && !retrievalConnections) loadRetrievalConnections();
  if (showSettings && !sensitivitySettings) loadSensitivitySettings();
  if (showSettings) requestAnimationFrame(updateSettingsNavActive);
  if (showDiagnostics) {
    loadDiagnostics();
    loadExtensionStatus();
  }
  if (showConnected) requestAnimationFrame(() => requestAnimationFrame(initMemoryGraph));
  const routeHash = `#${name}`;
  if (!showSettings || !["#summarizerForm", "#retrieval-settings", "#account-settings"].includes(location.hash)) {
    history.replaceState(null, "", routeHash);
  }
  window.scrollTo(0, 0);
}

function updateSettingsNavActive() {
  if ($("settingsView").classList.contains("hidden")) return;
  const links = [...document.querySelectorAll(".settings-nav a")];
  const sections = links.map((link) => document.querySelector(link.getAttribute("href"))).filter(Boolean);
  const anchorLine = Math.min(152, window.innerHeight * .28);
  const visible = sections.filter((section) => {
    const rect = section.getBoundingClientRect();
    return rect.bottom > anchorLine && rect.top < window.innerHeight;
  });
  const active = visible.sort((a, b) => {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    const aVisible = Math.max(0, Math.min(aRect.bottom, window.innerHeight) - Math.max(aRect.top, anchorLine));
    const bVisible = Math.max(0, Math.min(bRect.bottom, window.innerHeight) - Math.max(bRect.top, anchorLine));
    return bVisible - aVisible || Math.abs(aRect.top - anchorLine) - Math.abs(bRect.top - anchorLine);
  })[0] || sections[0];
  links.forEach((link) => {
    const selected = link.getAttribute("href") === `#${active?.id}`;
    link.classList.toggle("active", selected);
    if (selected) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
}
function renderRetrievalConnections(items) {
  retrievalConnections = items.filter((item) => item.provider !== "web_test");
  $("retrievalConnections").replaceChildren(...retrievalConnections.map((item) => {
    const row = document.createElement("div"); row.className = "connection-row";
    const copy = document.createElement("div"); copy.innerHTML = `<strong></strong><p class="muted">Read shared memory and receive source-backed context.</p>`; copy.querySelector("strong").textContent = item.provider;
    const controls = document.createElement("div"); controls.className = "connection-controls";
    for (const [field, label] of [["read_enabled", "Allow search"], ["write_notes_enabled", "Allow explicit notes"]]) {
      const control = document.createElement("label"); const input = document.createElement("input"); input.type = "checkbox"; input.checked = item[field];
      input.onchange = async () => { input.disabled = true; try { if (!isPreview) await api(`/v1/retrieval/connections?workspaceId=${workspace.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: item.provider, readEnabled: field === "read_enabled" ? input.checked : item.read_enabled, writeNotesEnabled: field === "write_notes_enabled" ? input.checked : item.write_notes_enabled }) }); item[field] = input.checked; if (isPreview) $("retrievalStatus").textContent = "Preview permission updated locally."; } catch (error) { input.checked = !input.checked; $("retrievalStatus").textContent = error.message; } finally { input.disabled = false; } };
      control.append(input, document.createTextNode(label)); controls.append(control);
    }
    row.append(copy, controls); return row;
  }));
}
async function loadRetrievalConnections() {
  try { const data = await api(`/v1/retrieval/connections?workspaceId=${workspace.id}`); renderRetrievalConnections(data.connections); }
  catch (error) { $("retrievalConnections").textContent = `Connections could not load: ${error.message}`; }
}
function renderSensitivitySettings(settings) {
  sensitivitySettings = settings;
  for (const [category, id] of [["financial", "sensitivityFinancial"], ["health", "sensitivityHealth"], ["personal", "sensitivityPersonal"]]) {
    const input = $(id);
    if (input) {
      input.checked = settings?.[`${category}_enabled`] === true;
      input.disabled = !settings;
    }
  }
}
async function loadSensitivitySettings() {
  renderSensitivitySettings(null);
  try {
    const data = await api(`/v1/retrieval/sensitivity?workspaceId=${workspace.id}`);
    renderSensitivitySettings(data.settings);
    $("sensitivityStatus").textContent = "";
  } catch (error) {
    renderSensitivitySettings(null);
    if ($("sensitivityStatus")) $("sensitivityStatus").textContent = `Sensitivity controls could not load: ${error.message}`;
  }
}
async function saveSensitivitySettings() {
  if (!sensitivitySettings) return;
  const settings = {
    financial_enabled: $("sensitivityFinancial").checked,
    health_enabled: $("sensitivityHealth").checked,
    personal_enabled: $("sensitivityPersonal").checked
  };
  if (isPreview) {
    renderSensitivitySettings({ ...sensitivitySettings, ...settings });
    $("sensitivityStatus").textContent = "Preview setting updated locally.";
    return;
  }
  try {
    $("sensitivityStatus").textContent = "Saving…";
    for (const id of ["sensitivityFinancial", "sensitivityHealth", "sensitivityPersonal"]) $(id).disabled = true;
    const data = await api(`/v1/retrieval/sensitivity?workspaceId=${workspace.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
    renderSensitivitySettings(data.settings);
    $("sensitivityStatus").textContent = "Saved. Connected AI tools will not receive disabled categories or unlabelled memory while a category is off.";
  } catch (error) {
    renderSensitivitySettings(sensitivitySettings);
    $("sensitivityStatus").textContent = `Could not save: ${error.message}`;
  }
}

function extensionRuntime() {
  return globalThis.chrome?.runtime || globalThis.browser?.runtime || null;
}

function extensionBridgeRequest(message, { retry = false, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    let interval = null;
    let fallback = null;
    let mailboxRequest = null;
    const cleanup = () => {
      window.removeEventListener("message", receive);
      document.removeEventListener("sherry-capture-response", receiveEvent);
      clearTimeout(timeout);
      clearTimeout(fallback);
      if (interval) clearInterval(interval);
      clearInterval(mailboxPoll);
      mailboxRequest?.remove();
    };
    const finish = (payload) => {
      if (payload?.source !== "sherry-extension-bridge" || payload?.requestId !== requestId) return;
      cleanup();
      resolve(payload.response);
    };
    const receive = (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      finish(event.data);
    };
    const receiveEvent = (event) => {
      try { finish(JSON.parse(event.detail)); } catch { /* Ignore malformed bridge events. */ }
    };
    const payload = { source: "sherry-web-app", requestId, ...message };
    const send = () => {
      const mailbox = document.getElementById("sherry-capture-bridge");
      if (mailbox && !mailboxRequest) {
        mailboxRequest = document.createElement("span");
        mailboxRequest.hidden = true;
        mailboxRequest.dataset.sherryRequestId = requestId;
        mailboxRequest.textContent = JSON.stringify(payload);
        mailbox.append(mailboxRequest);
      }
      document.dispatchEvent(new CustomEvent("sherry-capture-request", { detail: JSON.stringify(payload) }));
      fallback = setTimeout(() => window.postMessage(payload, location.origin), 120);
    };
    const mailboxPoll = setInterval(() => {
      if (mailboxRequest?.dataset.sherryResponse !== "true") return;
      try { finish(JSON.parse(mailboxRequest.textContent)); } catch { /* Wait for a complete response. */ }
    }, 40);
    const timeout = setTimeout(() => {
      cleanup();
      const detected = document.documentElement.dataset.sherryCaptureBridge;
      reject(new Error(detected
        ? `Sherry Capture v${detected} is present, but its background process did not respond.`
        : "No Sherry Capture page bridge is active. Use Sherry Capture 0.4.9 for automatic recovery on ChatGPT, Claude, and Gemini tabs, then reconnect this Sherry tab from the add-on popup."));
    }, timeoutMs);
    window.addEventListener("message", receive);
    document.addEventListener("sherry-capture-response", receiveEvent);
    send();
    if (retry) interval = setInterval(send, 150);
  });
}

async function bridgedExtensionMessage(message) {
  await extensionBridgeRequest({ type: "PING" }, { retry: true, timeoutMs: 5000 });
  const response = await extensionBridgeRequest(message, { timeoutMs: 10000 });
  if (!response?.ok) throw new Error(response?.error || "The extension did not accept the request.");
  return response;
}

async function connectExtensionWorkspace() {
  if (isPreview || !workspace?.id || !session?.access_token) return false;
  try {
    await extensionMessage({
      type: "UPDATE_INGESTION_CONFIG",
      payload: {
        endpoint: WORKER_URL,
        workspaceId: workspace.id,
        accessToken: session.access_token,
        refreshToken: session.refresh_token || "",
        expiresAt: session.expires_at || null,
        uploadExisting: false
      }
    });
    return true;
  } catch {
    return false;
  }
}

function extensionMessage(message) {
  const runtime = extensionRuntime();
  if (!runtime?.sendMessage) return bridgedExtensionMessage(message);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      const runtimeError = globalThis.chrome?.runtime?.lastError;
      if (runtimeError) reject(new Error(runtimeError.message));
      else if (!response?.ok) reject(new Error(response?.error || "The extension did not accept the request."));
      else resolve(response);
    };
    try {
      const result = runtime.sendMessage(EXTENSION_ID, message, finish);
      if (result?.then) result.then(finish).catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}

function setExtensionControlsDisabled(disabled) {
  ["extensionCaptureEnabled", "extensionCaptureAttachments", "extensionCaptureTemporary", "extensionDebugMode", "extensionRetry", "extensionReupload"].forEach((id) => {
    if ($(id)) $(id).disabled = disabled;
  });
}

function renderExtensionDiagnostics(data, errorMessage = "") {
  if (!$("diagnosticsExtensionEvents")) return;
  if (!data) {
    $("diagnosticsExtensionState").textContent = "No page bridge";
    $("diagnosticsExtensionState").className = "status-pill provisional";
    const empty = document.createElement("div");
    empty.className = "diagnostic-extension-empty";
    const title = document.createElement("strong");
    title.textContent = "Browser-local events unavailable in this tab";
    const copy = document.createElement("p");
    copy.textContent = "This does not mean cloud capture is unhealthy. To see browser-local events, open Sherry in the browser where Sherry Capture is installed and reconnect this tab from the extension popup.";
    empty.append(title, copy);
    $("diagnosticsExtensionEvents").replaceChildren(empty);
    return;
  }
  $("diagnosticsExtensionState").textContent = `v${data.version || "unknown"} connected`;
  $("diagnosticsExtensionState").className = "status-pill confirmed";
  const events = [...(data.diagnosticEvents || [])].slice(-20).reverse();
  if (!events.length) {
    $("diagnosticsExtensionEvents").replaceChildren(metricEmpty("The extension is connected and has not recorded any diagnostic events."));
    return;
  }
  $("diagnosticsExtensionEvents").replaceChildren(metricRows(events, [
    { strong: true, value: (event) => event.stage || event.type || "Extension event" },
    { value: (event) => {
      const candidates = event.detail?.candidates ?? event.detail?.initialCandidates;
      const emitted = event.detail?.emitted;
      const stored = event.detail?.stored;
      const counts = candidates == null ? "" : ` · ${candidates} visible${stored != null ? `, ${stored} stored changes` : emitted == null ? "" : `, ${emitted} sent`}`;
      return `${providerLabel(event.provider)} · ${event.status || "recorded"}${counts}`;
    } },
    { value: (event) => event.at ? new Date(event.at).toLocaleString() : "Time unavailable" }
  ]));
}

function renderExtensionStatus(data) {
  extensionStatusData = data;
  const settings = data.settings || {};
  const stats = data.captureStats || {};
  const ingestion = data.ingestion || {};
  $("extensionCaptureEnabled").checked = settings.captureEnabled !== false;
  $("extensionCaptureAttachments").checked = settings.captureAttachments === true;
  $("extensionCaptureTemporary").checked = settings.captureTemporaryChats === true;
  $("extensionDebugMode").checked = settings.debugMode === true;
  $("extensionState").textContent = ingestion.blockedReason || ingestion.quarantinedBatches
    ? "Needs attention"
    : ingestion.enabled && ingestion.hasAccessToken ? "Connected" : "Local only";
  $("extensionState").className = `status-pill ${ingestion.blockedReason || ingestion.quarantinedBatches ? "rejected" : "confirmed"}`;
  $("extensionCapturedCount").textContent = String(stats.totalEvents || 0);
  $("extensionPendingCount").textContent = String(ingestion.pendingBatches || 0);
  $("extensionLastCapture").textContent = stats.lastCaptureAt ? formatDateTime(stats.lastCaptureAt) : "Never";
  $("extensionControlStatus").textContent = ingestion.blockedReason || `Extension v${data.version || "unknown"} settings are live in Sherry.`;
  $("extensionRetry").disabled = !(ingestion.pendingBatches > 0);
  setExtensionControlsDisabled(false);
  $("extensionRetry").disabled = !(ingestion.pendingBatches > 0);
  renderExtensionDiagnostics(data);
}

async function loadExtensionStatus() {
  if (!$("extensionState")) return;
  if (isPreview) {
    $("extensionState").textContent = "Preview";
    $("extensionControlStatus").textContent = "Extension controls are available in the live app.";
    setExtensionControlsDisabled(true);
    renderExtensionDiagnostics(null, "Extension diagnostics require the live Sherry app and an installed browser extension.");
    return;
  }
  $("extensionControlStatus").textContent = "Checking for the Sherry browser extension…";
  try {
    renderExtensionStatus(await extensionMessage({ type: "GET_STATUS" }));
  } catch (error) {
    extensionStatusData = null;
    $("extensionState").textContent = "Unavailable here";
    $("extensionState").className = "status-pill provisional";
    $("extensionCapturedCount").textContent = "Not available";
    $("extensionPendingCount").textContent = "Not available";
    $("extensionLastCapture").textContent = "Not available";
    $("extensionControlStatus").textContent = `This tab cannot reach its browser extension: ${error.message} Cloud pipeline status above is independent of this connection.`;
    setExtensionControlsDisabled(true);
    renderExtensionDiagnostics(null, error.message);
  }
}

async function saveExtensionControls() {
  $("extensionControlStatus").textContent = "Saving extension settings…";
  try {
    await extensionMessage({
      type: "UPDATE_SETTINGS",
      payload: {
        captureEnabled: $("extensionCaptureEnabled").checked,
        captureAttachments: $("extensionCaptureAttachments").checked,
        captureTemporaryChats: $("extensionCaptureTemporary").checked,
        debugMode: $("extensionDebugMode").checked
      }
    });
    await loadExtensionStatus();
  } catch (error) {
    $("extensionControlStatus").textContent = `Could not save: ${error.message}`;
  }
}

async function runExtensionAction(type, pendingMessage) {
  $("extensionControlStatus").textContent = pendingMessage;
  try {
    await extensionMessage({ type });
    await loadExtensionStatus();
  } catch (error) {
    $("extensionControlStatus").textContent = error.message;
  }
}
async function testRetrieval(event) {
  event.preventDefault(); const query = $("retrievalQuery").value.trim(); if (!query) return;
  $("retrievalStatus").textContent = "Building the same context packet an AI would receive…";
  if (isPreview) {
    const data = { query, results: [{ rank: 1, memory: "User prefers detailed design feedback", source: "Detailed design feedback preferences", confidence: .98 }, { rank: 2, memory: "User prefers project updates as short bullet points", source: "Memory Test 4", confidence: .91 }], unresolvedConflicts: previewMemoryData.conflicts };
    $("retrievalResults").textContent = JSON.stringify(data, null, 2);
    $("retrievalResults").classList.remove("hidden");
    $("retrievalStatus").textContent = "2 ranked memory results in this design preview.";
    return;
  }
  try { const data = await api(`/v1/retrieval/test?workspaceId=${workspace.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) }); $("retrievalResults").textContent = JSON.stringify(data, null, 2); $("retrievalResults").classList.remove("hidden"); $("retrievalStatus").textContent = `${data.results.length} ranked memory results.`; }
  catch (error) { $("retrievalStatus").textContent = `Retrieval failed: ${error.message}`; }
}
function filteredConversations() {
  const query = conversationFilters.query.toLowerCase();
  const now = Date.now();
  return conversations.filter((item) => {
    const title = String(item.title || "").toLowerCase();
    const provider = String(item.provider || "").toLowerCase();
    const eventText = (item.events || []).map((event) => event.text_content || "").join(" ").toLowerCase();
    const summaryText = String(summaryForConversation(item)?.summary_text || "").toLowerCase();
    const matchesQuery = !query || title.includes(query) || provider.includes(query) || eventText.includes(query) || summaryText.includes(query);
    const matchesProvider = conversationFilters.provider === "all" || provider === conversationFilters.provider;
    const activityAt = new Date(conversationActivityAt(item) || 0).getTime();
    const age = now - activityAt;
    let matchesDate = conversationFilters.date === "all";
    if (conversationFilters.date === "custom") {
      const rangeStart = conversationFilters.dateFrom ? new Date(`${conversationFilters.dateFrom}T00:00:00`).getTime() : -Infinity;
      const rangeEnd = conversationFilters.dateTo ? new Date(`${conversationFilters.dateTo}T23:59:59.999`).getTime() : Infinity;
      matchesDate = activityAt >= rangeStart && activityAt <= rangeEnd;
    } else if (conversationFilters.date !== "all") {
      matchesDate = age <= Number(conversationFilters.date) * 86400000;
    }
    const surface = item.primary_surface || "web";
    const selectedSurface = conversationFilters.device === "browser" ? "web" : conversationFilters.device === "mobile" ? "android" : conversationFilters.device;
    const matchesDevice = selectedSurface === "all" || surface === selectedSurface;
    const hasArtifacts = Boolean(item.attachment_count || item.artifact_count);
    const matchesArtifacts = conversationFilters.artifacts === "all" || (conversationFilters.artifacts === "yes" ? hasArtifacts : !hasArtifacts);
    return matchesQuery && matchesProvider && matchesDate && matchesDevice && matchesArtifacts;
  });
}

function chatMessageCount(item) {
  return Number(item.conversation_events?.[0]?.count ?? item.message_count ?? 0) || 0;
}

function sortConversations(items, sort = chatSort) {
  const title = (item) => String(item.title || "Untitled conversation");
  const activity = (item) => new Date(conversationActivityAt(item) || 0).getTime() || 0;
  return [...items].sort((left, right) => {
    let difference = 0;
    if (sort === "oldest") difference = activity(left) - activity(right);
    else if (sort === "title-asc") difference = title(left).localeCompare(title(right), undefined, { sensitivity: "base" });
    else if (sort === "title-desc") difference = title(right).localeCompare(title(left), undefined, { sensitivity: "base" });
    else if (sort === "most-messages") difference = chatMessageCount(right) - chatMessageCount(left);
    else difference = activity(right) - activity(left);
    return difference || title(left).localeCompare(title(right), undefined, { sensitivity: "base" }) || String(left.id).localeCompare(String(right.id));
  });
}

function activateChat(item) {
  if (!selectingChats) return openConversation(item.id);
  if (selectedChatIds.has(item.id)) selectedChatIds.delete(item.id);
  else selectedChatIds.add(item.id);
  render();
  [...document.querySelectorAll("#conversations [data-conversation-id]")].find((target) => target.dataset.conversationId === item.id)?.focus();
}

function renderChatTable(items) {
  const table = document.createElement("table");
  table.className = "conversation-table";
  table.innerHTML = '<thead><tr><th scope="col">Chat</th><th scope="col">Platform</th><th scope="col">Messages</th><th scope="col">Last activity</th></tr></thead><tbody></tbody>';
  const body = table.querySelector("tbody");
  for (const item of items) {
    const row = document.createElement("tr");
    row.classList.toggle("selected", selectedChatIds.has(item.id));
    const titleCell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-row-button";
    button.dataset.conversationId = item.id;
    button.classList.toggle("selection-mode", selectingChats);
    button.classList.toggle("selected", selectedChatIds.has(item.id));
    if (selectingChats) {
      button.setAttribute("aria-pressed", String(selectedChatIds.has(item.id)));
      button.setAttribute("aria-label", `${selectedChatIds.has(item.id) ? "Deselect" : "Select"} ${item.title || "Untitled conversation"}`);
    }
    const title = document.createElement("strong");
    title.textContent = item.title || "Untitled conversation";
    const summary = document.createElement("small");
    summary.textContent = truncateText(summaryForConversation(item)?.summary_text, 110) || "No summary yet";
    button.append(title, summary);
    button.onclick = () => activateChat(item);
    titleCell.append(button);
    const provider = document.createElement("td");
    provider.textContent = providerLabel(item.provider);
    const messages = document.createElement("td");
    messages.textContent = String(chatMessageCount(item));
    const activity = document.createElement("td");
    activity.textContent = formatDateTime(conversationActivityAt(item));
    activity.title = conversationActivityLabel(item);
    row.append(titleCell, provider, messages, activity);
    body.append(row);
  }
  return table;
}

function render() {
  const visible = sortConversations(filteredConversations());
  if (!conversations.length) selectingChats = false;
  const availableIds = new Set(conversations.map((item) => item.id));
  for (const id of selectedChatIds) if (!availableIds.has(id)) selectedChatIds.delete(id);
  $("selectChats").textContent = selectingChats ? "Done selecting" : "Select chats";
  $("selectChats").setAttribute("aria-pressed", String(selectingChats));
  $("selectChats").disabled = deletingChats || !conversations.length || isPreview;
  $("chatSort").value = chatSort;
  $("chatGridView").setAttribute("aria-pressed", String(chatView === "grid"));
  $("chatTableView").setAttribute("aria-pressed", String(chatView === "table"));
  $("chatGridView").classList.toggle("active-segment", chatView === "grid");
  $("chatTableView").classList.toggle("active-segment", chatView === "table");
  $("conversations").classList.toggle("conversation-grid", chatView === "grid");
  $("conversations").classList.toggle("conversation-table-wrap", chatView === "table");
  $("chatSelectionActions").classList.toggle("hidden", !selectingChats);
  $("chatSelectionCount").textContent = `${selectedChatIds.size} chat${selectedChatIds.size === 1 ? "" : "s"} selected`;
  $("deleteSelectedChats").disabled = deletingChats || !selectedChatIds.size;
  $("selectVisibleChats").disabled = deletingChats || !visible.length;
  $("clearSelectedChats").disabled = deletingChats || !selectedChatIds.size;
  $("settingsDeleteChats").disabled = deletingChats || !conversations.length || isPreview;
  $("status").classList.remove("hidden");
  $("status").textContent = conversations.length
    ? visible.length === conversations.length
      ? `${visible.length} chat${visible.length === 1 ? "" : "s"}`
      : `${visible.length} of ${conversations.length} chats`
    : "No captured conversations yet.";
  const cards = chatView === "grid" ? visible.map((item) => {
    const button = document.createElement("button");
    button.className = "conversation";
    button.dataset.conversationId = item.id;
    button.classList.toggle("selection-mode", selectingChats);
    button.classList.toggle("selected", selectedChatIds.has(item.id));
    if (selectingChats) {
      button.setAttribute("aria-pressed", String(selectedChatIds.has(item.id)));
      button.setAttribute("aria-label", `${selectedChatIds.has(item.id) ? "Deselect" : "Select"} ${item.title || "Untitled conversation"}`);
    }
    const count = chatMessageCount(item);
    const summary = summaryForConversation(item);
    const description = truncateText(summary?.summary_text, 190) || "No conversation summary has been created yet.";
    button.innerHTML = `<div class="conversation-head"><span class="provider-slot"></span><span class="conversation-arrow" aria-hidden="true">→</span></div><h3></h3><p class="conversation-summary"></p><div class="meta"><span>${count} ${count === 1 ? "msg" : "msgs"}</span><span></span></div>`;
    button.querySelector(".provider-slot").replaceWith(providerIcon(item.provider));
    button.querySelector("h3").textContent = item.title || "Untitled conversation";
    button.querySelector(".conversation-summary").textContent = description;
    const activity = button.querySelector(".meta span:last-child");
    activity.textContent = formatDateTime(conversationActivityAt(item));
    activity.title = conversationActivityLabel(item);
    button.onclick = () => activateChat(item);
    return button;
  }) : [];
  $("conversations").replaceChildren(...(visible.length
    ? chatView === "table" ? [renderChatTable(visible)] : cards
    : [emptyState(conversations.length ? "No conversations match these Chat Memory filters." : "Captured conversations will appear here after the extension sends them to Memory.")]));
  renderDashboard();
}

function updateConversationFilters() {
  const customDateActive = $("dateFilter").value === "custom";
  $("customDateFields").classList.toggle("hidden", !customDateActive);
  conversationFilters = {
    query: $("conversationSearch").value.trim(),
    provider: $("providerFilter").value,
    device: $("deviceFilter").value,
    date: $("dateFilter").value,
    dateFrom: $("dateFrom").value,
    dateTo: $("dateTo").value,
    artifacts: $("artifactFilter").value
  };
  render();
}

async function refreshChatMemory() {
  if (refreshingChatMemory) return;
  const button = $("refreshChatMemory");
  const label = button.querySelector("span");
  const status = $("chatMemoryRefreshStatus");
  refreshingChatMemory = true;
  button.disabled = true;
  label.textContent = "Refreshing…";
  status.classList.remove("error");
  status.textContent = "Checking for updated chats…";
  try {
    if (isPreview) {
      status.textContent = "Sample data cannot refresh.";
      return;
    }
    if (!workspace?.id) throw new Error("No active workspace is available.");
    const [chatResult, summaryResult] = await Promise.allSettled([
      api(`/v1/conversations?workspaceId=${workspace.id}`, { cache: "no-store" }),
      api(`/v1/summaries?workspaceId=${workspace.id}`, { cache: "no-store" })
    ]);
    if (chatResult.status === "rejected") throw chatResult.reason;
    if (!Array.isArray(chatResult.value?.conversations)) throw new Error("The chat list was not returned.");
    conversations = chatResult.value.conversations;
    const summariesUpdated = summaryResult.status === "fulfilled" && Array.isArray(summaryResult.value?.summaries);
    if (summariesUpdated) summaries = summaryResult.value.summaries;
    render();
    status.textContent = summariesUpdated ? "Checked just now." : "Chats updated; summaries could not refresh.";
    status.classList.toggle("error", !summariesUpdated);
  } catch (error) {
    status.classList.add("error");
    status.textContent = `Could not refresh chats: ${error.message}`;
  } finally {
    refreshingChatMemory = false;
    button.disabled = false;
    label.textContent = "Refresh";
  }
}

function openBulkDeleteDialog(ids, allChats) {
  if (!ids.length || deletingChats) return;
  bulkDeleteTarget = { ids: [...new Set(ids)], allChats };
  const count = bulkDeleteTarget.ids.length;
  $("bulkDeleteTitle").textContent = allChats ? "Delete all chats from Sherry?" : `Delete ${count} selected chat${count === 1 ? "" : "s"}?`;
  $("bulkDeleteDescription").textContent = allChats
    ? `This will delete all ${count} chats currently stored in this workspace.`
    : `This will delete the ${count} chats you selected in Chat Memory.`;
  $("bulkDeleteConfirmationLabel").classList.toggle("hidden", !allChats);
  $("bulkDeleteConfirmation").value = "";
  $("bulkDeleteStatus").textContent = "";
  $("confirmBulkDelete").disabled = allChats;
  $("bulkDeleteDialog").showModal();
}

async function deleteChatBatch() {
  if (!bulkDeleteTarget || deletingChats || !workspace?.id || isPreview) return;
  const { ids, allChats } = bulkDeleteTarget;
  if (allChats && $("bulkDeleteConfirmation").value !== "DELETE ALL CHATS") return;
  deletingChats = true;
  $("cancelBulkDelete").disabled = true;
  $("confirmBulkDelete").disabled = true;
  $("bulkDeleteDialog").close();
  render();
  let deleted = 0;
  let cleanupPending = 0;
  const failed = [];
  const progress = (message) => {
    $("chatBulkStatus").textContent = message;
    $("settingsDeleteChatsStatus").textContent = message;
  };
  for (const id of ids) {
    progress(`Deleting chats… ${deleted + failed.length} of ${ids.length} processed.`);
    try {
      const result = await api(`/v1/conversations/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspace.id)}`, { method: "DELETE" });
      if (result?.deleted?.cleanupPending) cleanupPending += 1;
      deleted += 1;
      conversations = conversations.filter((chat) => chat.id !== id);
      summaries = (summaries || []).filter((summary) => summary.conversation_id !== id);
      selectedChatIds.delete(id);
    } catch (error) {
      if (error.status === 404) {
        deleted += 1;
        conversations = conversations.filter((chat) => chat.id !== id);
        summaries = (summaries || []).filter((summary) => summary.conversation_id !== id);
        selectedChatIds.delete(id);
      } else {
        failed.push(id);
        if (error.status === 401 || error.status === 403) break;
      }
    }
  }
  try {
    const [chatResult, summaryResult, dashboardResult] = await Promise.allSettled([
      api(`/v1/conversations?workspaceId=${workspace.id}`, { cache: "no-store" }),
      api(`/v1/summaries?workspaceId=${workspace.id}`, { cache: "no-store" }),
      api(`/v1/dashboard?workspaceId=${workspace.id}`, { cache: "no-store" })
    ]);
    const chatsVerified = chatResult.status === "fulfilled" && Array.isArray(chatResult.value?.conversations);
    if (chatsVerified) conversations = chatResult.value.conversations;
    if (summaryResult.status === "fulfilled" && Array.isArray(summaryResult.value?.summaries)) summaries = summaryResult.value.summaries;
    dashboardData = dashboardResult.status === "fulfilled" ? dashboardResult.value : dashboardFallbackFromConversations(conversations);
    const remaining = new Set(conversations.map((chat) => chat.id));
    if (selected && !remaining.has(selected.id)) selected = null;
    if (selectedSummary && !remaining.has(selectedSummary.conversation_id)) selectedSummary = null;
    const stillPresent = ids.filter((id) => remaining.has(id));
    const confirmedRemoved = ids.length - stillPresent.length;
    const newChats = allChats ? conversations.filter((chat) => !ids.includes(chat.id)).length : 0;
    const message = !chatsVerified
      ? `${deleted} deletion requests succeeded, but Sherry could not verify the remaining chat list. Refresh Chat Memory before retrying.`
      : stillPresent.length
        ? `${confirmedRemoved} of ${ids.length} chats deleted. ${stillPresent.length} remain; you can select them and retry.`
        : `${confirmedRemoved} chat${confirmedRemoved === 1 ? "" : "s"} deleted from Sherry.${newChats ? ` ${newChats} newer chat${newChats === 1 ? " remains" : "s remain"}.` : ""}${cleanupPending ? ` Raw backup cleanup is still running for ${cleanupPending}.` : ""}`;
    progress(message);
  } catch (error) {
    progress(`${deleted} chats deleted. Could not refresh the remaining list: ${error.message}`);
  } finally {
    deletingChats = false;
    bulkDeleteTarget = null;
    render();
  }
}

function closeProviderMenu() {
  $("providerFilterMenu").classList.add("hidden");
  $("providerFilterButton").setAttribute("aria-expanded", "false");
}

function selectProviderFilter(value, label) {
  $("providerFilter").value = value;
  $("providerFilterLabel").textContent = label;
  document.querySelectorAll("#providerFilterMenu .select-option[data-value]").forEach((option) => {
    const selectedOption = option.dataset.value === value;
    option.classList.toggle("selected", selectedOption);
    option.setAttribute("aria-selected", String(selectedOption));
  });
  closeProviderMenu();
  updateConversationFilters();
}

function importTimestamp(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function importMessageText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(importMessageText).filter(Boolean).join("\n").trim();
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text.trim();
  if (typeof value.message === "string") return value.message.trim();
  if (Array.isArray(value.parts)) return importMessageText(value.parts);
  if (value.content != null) return importMessageText(value.content);
  return "";
}

function importRole(message) {
  const role = String(message?.role || message?.sender || message?.author?.role || message?.from || "unknown").toLowerCase();
  if (["user", "human", "prompt"].includes(role)) return "user";
  if (["assistant", "ai", "bot", "model", "claude", "gemini"].includes(role)) return "assistant";
  if (["system", "tool"].includes(role)) return role;
  return "unknown";
}

function importAttachments(message) {
  const candidates = message?.attachments || message?.files || message?.metadata?.attachments || [];
  return (Array.isArray(candidates) ? candidates : []).slice(0, 25).map((item) => ({
    name: String(item?.name || item?.file_name || item?.filename || "Attachment").slice(0, 500),
    type: String(item?.mime_type || item?.type || "unknown").slice(0, 200),
    size: Number.isFinite(Number(item?.size)) ? Number(item.size) : null,
    sourceOnly: true
  }));
}

function normalizeImportMessage(message, index) {
  const text = importMessageText(message?.content ?? message?.text ?? message?.message ?? message);
  if (!text) return null;
  return {
    id: String(message?.id || message?.uuid || message?.message_id || index),
    role: importRole(message),
    text: text.slice(0, 240_000),
    timestamp: importTimestamp(message?.create_time || message?.created_at || message?.timestamp || message?.time),
    attachments: importAttachments(message)
  };
}

function normalizeChatGptExport(data) {
  const records = Array.isArray(data) ? data : data?.conversations;
  if (!Array.isArray(records)) return [];
  return records.map((record, recordIndex) => {
    const nodes = record?.mapping ? Object.values(record.mapping) : [];
    const rawMessages = nodes.length ? nodes.map((node) => node?.message).filter(Boolean) : (record?.messages || []);
    const messages = rawMessages.map(normalizeImportMessage).filter(Boolean).sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
    const id = String(record?.id || record?.conversation_id || recordIndex);
    return {
      id,
      title: String(record?.title || "Imported ChatGPT conversation").slice(0, 1000),
      sourceUrl: /^[0-9a-f-]{8,}$/i.test(id) ? `https://chatgpt.com/c/${id}` : null,
      messages
    };
  }).filter((record) => record.messages.length);
}

function normalizeGeminiExport(data) {
  const records = Array.isArray(data) ? data : data?.conversations || data?.chats || data?.activity || [];
  if (!Array.isArray(records)) return [];
  return records.map((record, recordIndex) => {
    const rawMessages = record?.messages || record?.turns || record?.chat_messages || record?.events;
    const fallbackText = importMessageText(record?.details || record?.description || record?.title);
    const messages = Array.isArray(rawMessages)
      ? rawMessages.map(normalizeImportMessage).filter(Boolean)
      : (fallbackText ? [{ id: String(recordIndex), role: "user", text: fallbackText, timestamp: importTimestamp(record?.time || record?.timestamp), attachments: [] }] : []);
    return {
      id: String(record?.id || record?.conversation_id || recordIndex),
      title: String(record?.name || record?.header || record?.title || "Imported Gemini activity").slice(0, 1000),
      sourceUrl: null,
      messages
    };
  }).filter((record) => record.messages.length);
}

function normalizeGeminiHtml(text) {
  const documentValue = new DOMParser().parseFromString(text, "text/html");
  const cells = [...documentValue.querySelectorAll(".outer-cell")];
  const records = cells.length ? cells : [documentValue.body];
  return records.map((cell, index) => {
    const copy = cell.cloneNode(true);
    copy.querySelectorAll("style, script").forEach((item) => item.remove());
    const content = copy.textContent.replace(/\s+/g, " ").trim();
    const timestamp = importTimestamp(cell.querySelector("time")?.getAttribute("datetime") || cell.querySelector("time")?.textContent);
    return {
      id: `gemini-takeout-${index}`,
      title: content.slice(0, 80) || `Gemini activity ${index + 1}`,
      sourceUrl: null,
      messages: content ? [{ id: String(index), role: "user", text: content.slice(0, 240_000), timestamp, attachments: [] }] : []
    };
  }).filter((record) => record.messages.length);
}

async function sha256Text(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fnv1aText(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function importedCaptureEvents(provider, conversation) {
  const capturedAt = new Date().toISOString();
  return Promise.all(conversation.messages.map(async (message, sequence) => {
    const fingerprint = await sha256Text(`${provider}\n${conversation.id}\n${message.id}\n${message.role}\n${message.text}`);
    const isClaude = provider === "claude";
    return {
      eventId: isClaude ? `evt_${fnv1aText(`claude|${conversation.id}|${message.id}`)}` : `evt_import_${fingerprint.slice(0, 40)}`,
      provider,
      conversationId: conversation.id.slice(0, 512),
      providerMessageId: message.id.slice(0, 512),
      sequence: message.sequence ?? sequence,
      role: message.role,
      text: message.text,
      contentHash: isClaude ? fnv1aText(SherryClaudeImport.compact(message.text)) : `sha256:${fingerprint}`,
      sourceUrl: conversation.sourceUrl,
      sourceLocator: `historical-import:${provider}:${conversation.id}:${message.id}`.slice(0, 1024),
      chatTitle: conversation.title,
      messageTimestamp: message.timestamp,
      capturedAt,
      links: [],
      attachments: message.attachments
    };
  }));
}

async function previewClaudeImport(file) {
  const data = JSON.parse(await file.text());
  const normalized = SherryClaudeImport.normalize(data);
  if (!normalized.conversations.length) throw new Error("No Claude conversations with visible chat text were found.");
  const existingResponse = await api(`/v1/conversations?workspaceId=${workspace.id}`);
  const existing = existingResponse.conversations || [];
  const unidentified = existing.filter((item) => item.provider === "claude"
    && !/\/chat\/[^/]+/.test(item.canonical_chat_url || ""));
  const unidentifiedDetails = await Promise.all(unidentified.map(async (item) =>
    (await api(`/v1/conversations/${item.id}?workspaceId=${workspace.id}`)).conversation.events || []));
  const counts = { newConversations: 0, overlappingConversations: 0, newMessages: 0, duplicates: 0, ambiguous: 0 };
  const importable = [];
  for (const conversation of normalized.conversations) {
    const matches = SherryClaudeImport.matchConversation(conversation, existing);
    if (matches.length > 1) {
      counts.ambiguous += conversation.messages.length;
      continue;
    }
    if (!matches.length) {
      if (SherryClaudeImport.possibleUnidentifiedOverlap(conversation, existing)
        || unidentifiedDetails.some((events) => SherryClaudeImport.possibleContentOverlap(conversation, events))) {
        counts.ambiguous += conversation.messages.length;
        continue;
      }
      counts.newConversations += 1;
      counts.newMessages += conversation.messages.length;
      importable.push(conversation);
      continue;
    }
    counts.overlappingConversations += 1;
    const detail = (await api(`/v1/conversations/${matches[0].id}?workspaceId=${workspace.id}`)).conversation;
    const messages = [];
    for (const message of conversation.messages) {
      const result = SherryClaudeImport.classifyMessage(message, detail.events || []);
      if (result === "new") {
        messages.push(message);
        counts.newMessages += 1;
      } else if (result === "duplicate") counts.duplicates += 1;
      else counts.ambiguous += 1;
    }
    if (messages.length) importable.push({ ...conversation, messages });
  }
  return { file, counts, importable, stats: normalized.stats };
}

async function uploadImportedConversation(provider, conversation, importSessionId) {
  const providerFamily = { chatgpt: "openai", claude: "anthropic", gemini: "google" }[provider];
  const events = await importedCaptureEvents(provider, conversation);
  let uploaded = 0;
  let offset = 0;
  while (offset < events.length) {
    const batchId = crypto.randomUUID();
    const batchBase = {
      schemaVersion: 2,
      batchId,
      workspaceId: workspace.id,
      provider,
      providerFamily,
      product: provider,
      surface: "desktop",
      reason: "historical_import",
      clientCreatedAt: new Date().toISOString(),
      captureClient: { type: "historical_import", adapterVersion: "1.0.0", deviceId: "sherry-web-import", os: "unknown", appVersion: "web", captureSessionId: importSessionId },
      coverage: { state: "complete_observed_range", gapBefore: false, backfillAvailable: false }
    };
    let end = Math.min(offset + 75, events.length);
    let batch = { ...batchBase, events: events.slice(offset, end) };
    while (end > offset + 1 && new TextEncoder().encode(JSON.stringify(batch)).byteLength > 450_000) {
      end -= 1;
      batch = { ...batchBase, events: events.slice(offset, end) };
    }
    const receipt = await api("/v1/capture/batches", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": batchId }, body: JSON.stringify(batch) });
    uploaded += SherryImportIntegrity.verifyReceipt(receipt, batch.events.length);
    offset = end;
  }
  return uploaded;
}

async function importProviderHistory(event) {
  event.preventDefault();
  const file = $("historyImportFile").files?.[0];
  const provider = $("historyImportProvider").value;
  const button = $("historyImportButton");
  if (!file) return;
  if (file.size > 200 * 1024 * 1024) {
    $("historyImportStatus").textContent = "Choose an extracted export file smaller than 200 MB.";
    return;
  }
  button.disabled = true;
  $("historyImportStatus").textContent = "Reading the export locally…";
  let uploadStarted = false;
  try {
    if (provider === "claude" && (!pendingClaudeImport || pendingClaudeImport.file !== file)) {
      pendingClaudeImport = await previewClaudeImport(file);
      const { counts, stats } = pendingClaudeImport;
      $("historyImportStatus").textContent = `Claude preview: ${counts.newConversations} new chats, ${counts.overlappingConversations} overlapping chats; ${counts.newMessages} new messages, ${counts.duplicates} duplicates, ${counts.ambiguous} held for review. ${stats.nonTextMessages} non-text messages and ${stats.nonTextConversations} non-text-only chats excluded. Claude summaries and attachment contents are not imported; file references stay as metadata. No data has been uploaded.`;
      button.textContent = counts.newMessages ? `Import ${counts.newMessages} new messages` : "Nothing new to import";
      button.disabled = !counts.newMessages;
      return;
    }
    let imported;
    if (provider === "claude") imported = pendingClaudeImport.importable;
    else if (provider === "gemini" && /\.html?$/i.test(file.name)) imported = normalizeGeminiHtml(await file.text());
    else {
      const data = JSON.parse(await file.text());
      imported = provider === "chatgpt" ? normalizeChatGptExport(data) : normalizeGeminiExport(data);
    }
    if (!imported.length) throw new Error("No supported conversations were found in this file.");
    SherryImportIntegrity.verifyImportPlan(imported);
    const importSessionId = `import:${crypto.randomUUID()}`;
    let messageCount = 0;
    for (let index = 0; index < imported.length; index += 1) {
      $("historyImportStatus").textContent = `Importing chat ${index + 1} of ${imported.length}…`;
      uploadStarted = true;
      messageCount += await uploadImportedConversation(provider, imported[index], importSessionId);
    }
    $("historyImportStatus").textContent = "Checking imported messages in Sherry…";
    const [conversationResponse, dashboardResponse] = await Promise.all([
      api(`/v1/conversations?workspaceId=${workspace.id}`),
      api(`/v1/dashboard?workspaceId=${workspace.id}`)
    ]);
    conversations = conversationResponse.conversations || [];
    let readBackCount = 0;
    for (const importedChat of imported) {
      const matches = conversations.filter((chat) => chat.provider === provider && chat.provider_conversation_id === importedChat.id);
      if (matches.length !== 1) throw new Error("Sherry could not find an imported chat in the cloud. Review the import before retrying.");
      const identityRecord = await api(`/v1/conversations/${matches[0].id}/event-identities?workspaceId=${workspace.id}`);
      if (identityRecord.conversation?.provider_conversation_id !== importedChat.id) {
        throw new Error("Sherry found a different chat during cloud readback.");
      }
      readBackCount += SherryImportIntegrity.verifyReadback(importedChat.messages, identityRecord.events);
    }
    if (readBackCount !== messageCount) throw new Error("The imported message count did not match Sherry's cloud readback.");
    dashboardData = dashboardResponse;
    render();
    prepareExport();
    const sourceLimit = provider === "gemini"
      ? "Gemini activity exports may omit AI replies."
      : "Provider exports may omit non-text content.";
    $("historyImportStatus").textContent = `Sherry confirmed ${messageCount} visible message${messageCount === 1 ? "" : "s"} from ${imported.length} chat${imported.length === 1 ? "" : "s"} in this file. This checks delivery from the file, not whether the provider export contains every original message. ${sourceLimit} Attachment files were not uploaded.`;
    $("historyImportFile").value = "";
    pendingClaudeImport = null;
    button.textContent = provider === "claude" ? "Preview Claude import" : "Import chats";
  } catch (error) {
    $("historyImportStatus").textContent = uploadStarted
      ? `Import stopped: ${error.message} Some messages may already be in Sherry. Retrying the same file checks duplicates before adding new messages.`
      : `Import could not start: ${error.message}`;
  } finally {
    button.disabled = provider === "claude" && pendingClaudeImport?.counts.newMessages === 0;
  }
}

function updateHistoryImportProvider() {
  pendingClaudeImport = null;
  const provider = $("historyImportProvider").value;
  $("historyImportButton").textContent = provider === "claude" ? "Preview Claude import" : "Import chats";
  $("historyImportButton").disabled = false;
  $("historyImportStatus").textContent = "";
  $("historyImportHelp").textContent = provider === "claude"
    ? "Choose conversations.json from your Claude export. Review overlap and duplicate counts before importing."
    : provider === "gemini"
      ? "Choose Gemini Takeout JSON or HTML activity data."
      : "Choose conversations.json from your ChatGPT export.";
}

async function prepareExport() {
  exportPayload = null;
  try {
    if (isPreview) {
      exportPayload = { exportedAt: new Date().toISOString(), workspace: workspace.name, conversations, summaries, personalMemory: { entries: personalMemoryEntries, categories: personalMemoryCustomCategories } };
      return;
    }
    const [full, summaryResponse, noteResponse] = await Promise.all([
      Promise.all(conversations.map(async (conversation) =>
        (await api(`/v1/conversations/${conversation.id}?workspaceId=${workspace.id}`)).conversation
      )),
      api(`/v1/summaries?workspaceId=${workspace.id}`),
      api(`/v1/personal-memory?workspaceId=${workspace.id}`)
    ]);
    exportPayload = {
      exportedAt: new Date().toISOString(),
      workspace: workspace.name,
      conversations: full,
      summaries: summaryResponse.summaries || [],
      personalMemory: { entries: noteResponse.entries || [], categories: noteResponse.categories || [] }
    };
  } catch (error) {
    exportPayload = null;
    console.warn("Workspace export could not be prepared", error);
  }
}

function bootPreview() {
  bootDataAlerts = [];
  workspace = { id: "preview", name: "Personal space" };
  conversations = previewConversations;
  summaries = [previewSummary];
  memoryData = previewMemoryData;
  dashboardData = previewDashboardMetrics();
  summarizerSettings = { enabled: true, intervalMinutes: 10, provider: "anthropic", model: "claude-sonnet-5", apiKeyConfigured: true, apiKeyHint: "••••preview" };
  retrievalConnections = [
    { provider: "chatgpt", read_enabled: true, write_notes_enabled: true },
    { provider: "claude", read_enabled: true, write_notes_enabled: true },
    { provider: "gemini", read_enabled: true, write_notes_enabled: false }
  ];
  sensitivitySettings = { financial_enabled: true, health_enabled: true, personal_enabled: true };
  $("workspaceName").textContent = workspace.name;
  $("dashboardDataSource").classList.remove("hidden");
  $("memoryDataSource").classList.remove("hidden");
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("signOut").classList.add("hidden");
  $("primaryNav").classList.remove("hidden");
  showView(initialViewFromHash());
  render();
  renderMemory();
  renderPersonalMemoryCategories();
  renderSettings(summarizerSettings);
  renderRetrievalConnections(retrievalConnections);
  renderSensitivitySettings(sensitivitySettings);
  prepareExport();
  loadDiagnostics();
}

async function boot(allowRefresh = true) {
  if (isPreview) return bootPreview();
  if (!session?.access_token) return showAuth();
  try {
    const spaces = await supabase("/rest/v1/workspaces?select=id,name&limit=1");
    workspace = spaces[0];
    if (!workspace) throw new Error("No workspace found");
    $("workspaceName").textContent = workspace.name;
    void connectExtensionWorkspace();
    const requests = await Promise.allSettled([
      api(`/v1/conversations?workspaceId=${workspace.id}`),
      api(`/v1/dashboard?workspaceId=${workspace.id}`),
      api(`/v1/summaries?workspaceId=${workspace.id}`),
      api(`/v1/personal-memory?workspaceId=${workspace.id}`)
    ]);
    const unauthorized = requests.find((result) => result.status === "rejected" && result.reason?.status === 401);
    if (unauthorized) throw unauthorized.reason;
    const value = (index, fallback) => requests[index].status === "fulfilled" ? requests[index].value : fallback;
    const conversationResponse = value(0, { conversations: [] });
    conversations = conversationResponse.conversations || [];
    dashboardData = value(1, dashboardFallbackFromConversations(conversations));
    summaries = value(2, { summaries: [] }).summaries || [];
    memoryData = { claims: [], conflicts: [] };
    const livePersonalMemory = value(3, { entries: [], categories: [] });
    personalMemoryEntries = livePersonalMemory.entries || [];
    personalMemoryCustomCategories = livePersonalMemory.categories || [];
    const labels = ["Chat Memory", "dashboard metrics", "summaries", "Personal Memory"];
    const unavailable = requests.flatMap((result, index) => result.status === "rejected" ? [labels[index]] : []);
    bootDataAlerts = unavailable.length ? [{
      severity: "warning",
      title: "Some live data could not load",
      message: `${unavailable.join(", ")} ${unavailable.length === 1 ? "is" : "are"} temporarily unavailable. Other sections remain usable.`,
      action: "Refresh after the service update is published."
    }] : [];
    $("dashboardDataSource").classList.add("hidden");
    $("memoryDataSource").classList.add("hidden");
    $("auth").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("signOut").classList.remove("hidden");
    $("primaryNav").classList.remove("hidden");
    showView(initialViewFromHash());
    render();
    renderMemory();
    renderPersonalMemoryCategories();
    renderSystemAlerts({ alerts: [] });
    prepareExport();
    loadDiagnostics();
  } catch(error) {
    if (error.status === 401 && allowRefresh && await refreshSession()) return boot(false);
    if (error.status === 401) { localStorage.removeItem("memory_session");session=null;showAuth();$("authError").textContent="Your session expired. Please sign in again."; return; }
    workspace ||= { id: null, name: "Personal space" };
    conversations = [];
    summaries = [];
    memoryData = { claims: [], conflicts: [] };
    dashboardData = dashboardFallbackFromConversations();
    personalMemoryEntries = [];
    personalMemoryCustomCategories = [];
    bootDataAlerts = [{
      severity: "error",
      title: "Live data could not load",
      message: error.message || "Sherry could not reach the memory service.",
      action: "Your data has not been replaced or deleted. Refresh after the service is available."
    }];
    $("auth").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("signOut").classList.remove("hidden");
    $("primaryNav").classList.remove("hidden");
    showView(initialViewFromHash());
    render();
    renderMemory();
    renderPersonalMemoryCategories();
    renderSystemAlerts({ alerts: [] });
  }
}
function renderSettings(settings) {
  summarizerSettings = settings;
  $("summarizerEnabled").checked = settings.enabled;
  $("intervalMinutes").value = String(settings.intervalMinutes);
  $("summarizerProvider").value = settings.provider;
  $("summarizerModel").value = settings.model || "";
  const legacyAnthropicModel = settings.provider === "anthropic" && settings.model === "claude-sonnet";
  $("summarizerModelHelp").textContent = legacyAnthropicModel
    ? "This model alias is not accepted by Anthropic. Replace it with a current exact model ID, such as claude-sonnet-5, then save."
    : "Use the exact model ID from your provider.";
  $("summarizerModelHelp").classList.toggle("field-error", legacyAnthropicModel);
  $("summarizerApiKey").value = "";
  $("apiKeyState").textContent = settings.apiKeyConfigured
    ? `Saved securely (${settings.apiKeyHint || "encrypted"}). The field is cleared after saving because Sherry never displays stored keys. Leave it blank to keep this key.`
    : "No API key saved.";
  $("removeApiKey").classList.toggle("hidden", !settings.apiKeyConfigured);
  $("runSummaryNow").disabled = !settings.apiKeyConfigured || !settings.model;
}
async function loadSettings() {
  $("settingsStatus").textContent = "Loading settings…";
  try {
    const data = await api(`/v1/settings/summarizer?workspaceId=${workspace.id}`);
    renderSettings(data.settings);
    $("settingsStatus").textContent = "";
  } catch (error) {
    $("settingsStatus").textContent = `Settings could not load: ${error.message}`;
  }
}
function settingsPayload(removeApiKey = false) {
  return {
    enabled: $("summarizerEnabled").checked,
    intervalMinutes: Number($("intervalMinutes").value),
    provider: $("summarizerProvider").value,
    model: $("summarizerModel").value,
    apiKey: $("summarizerApiKey").value,
    removeApiKey
  };
}
async function saveSettings(removeApiKey = false) {
  const payload = settingsPayload(removeApiKey);
  const replacedApiKey = Boolean(payload.apiKey);
  $("saveSettings").disabled = true;
  $("removeApiKey").disabled = true;
  $("settingsStatus").textContent = removeApiKey ? "Removing key…" : "Saving…";
  if (isPreview) {
    summarizerSettings = { ...summarizerSettings, ...payload, apiKeyConfigured: removeApiKey ? false : true, apiKeyHint: removeApiKey ? null : "••••preview" };
    renderSettings(summarizerSettings);
    $("settingsStatus").textContent = removeApiKey ? "Preview API key removed locally." : "Preview settings saved locally.";
    $("saveSettings").disabled = false;
    $("removeApiKey").disabled = false;
    return;
  }
  try {
    const data = await api(`/v1/settings/summarizer?workspaceId=${workspace.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    renderSettings(data.settings);
    $("settingsStatus").textContent = removeApiKey
      ? "API key removed. Automatic summaries are paused until a new key is saved."
      : replacedApiKey
        ? "Settings and the replacement API key were saved. You can retry the failed summary now."
        : "Settings saved. The existing API key was kept.";
  } catch (error) {
    $("settingsStatus").textContent = `Could not save: ${error.message}`;
  } finally {
    $("saveSettings").disabled = false;
    $("removeApiKey").disabled = false;
  }
}
async function runSummaryNow() {
  $("runSummaryNow").disabled = true;
  $("settingsStatus").textContent = "Running the next eligible summary…";
  if (isPreview) {
    $("settingsStatus").textContent = "Preview complete: one changed conversation would be summarized, with no real model call.";
    $("runSummaryNow").disabled = false;
    return;
  }
  try {
    const result = await api(`/v1/summaries/run?workspaceId=${workspace.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    const job = result.jobs?.[0];
    if (result.status === "protected") {
      $("settingsStatus").textContent = "Sherry protected you from repeating the same failed model call. Save a changed model, provider, or replacement API key, then retry.";
      await loadDiagnostics();
    } else if (result.status === "no_work") {
      $("settingsStatus").textContent = "Everything is already summarized.";
    } else if (job?.status === "completed") {
      const chatTitle = conversations.find((conversation) => conversation.id === job.conversationId)?.title || "a conversation";
      $("settingsStatus").textContent = `Summary ${job.version ? `v${job.version} ` : ""}saved for “${chatTitle}”.`;
      await loadSummaries();
      render();
    } else if (job?.retryScheduled) {
      $("settingsStatus").textContent = "The model provider is temporarily unavailable. Sherry will retry safely.";
    } else {
      const chatTitle = conversations.find((conversation) => conversation.id === job?.conversationId)?.title || "this conversation";
      $("settingsStatus").textContent = `Could not summarize “${chatTitle}”: ${job?.errorDetail || "The attempt did not complete. Check Diagnostics for details."}`;
    }
  } catch (error) {
    $("settingsStatus").textContent = `Could not run summary: ${error.message}`;
  } finally {
    $("runSummaryNow").disabled = !summarizerSettings?.apiKeyConfigured || !summarizerSettings?.model;
  }
}
function emptyState(message) {
  const item = document.createElement("div");
  item.className = "empty-state";
  item.textContent = message;
  return item;
}
function statusPill(status) {
  const pill = document.createElement("span");
  pill.className = `status-pill ${status}`;
  pill.textContent = status.replaceAll("_", " ");
  return pill;
}
function renderSummaries() {
  if (selected) renderConversationSummary(selected);
}
async function loadSummaries() {
  try {
    const data = await api(`/v1/summaries?workspaceId=${workspace.id}`);
    summaries = data.summaries;
    renderSummaries();
    return true;
  } catch (error) {
    if ($("conversationSummaryStatus")) $("conversationSummaryStatus").textContent = `Summary could not load: ${error.message}`;
    return false;
  }
}
function renderSummaryDialog(summary) {
  selectedSummary = summary;
  $("summaryProvider").replaceChildren(providerIcon(summary.conversation?.provider || summary.provider));
  $("summaryTitle").textContent = summary.conversation?.title || "Conversation summary";
  $("summaryMeta").textContent = `v${summary.version} · ${summary.status.replaceAll("_", " ")} · created ${formatDateTime(summary.created_at)}${summary.edited_at ? ` · edited ${formatDateTime(summary.edited_at)}` : ""}`;
  $("summaryText").value = summary.summary_text;
  setOriginalChatLink($("summarySourceLink"), summary.conversation?.canonical_chat_url);
  const detailValues = [
    summary.model ? `Model: ${summary.model}` : null,
    summary.total_tokens != null ? `${summary.total_tokens} tokens` : null,
    summary.exact_cost_usd != null ? `$${Number(summary.exact_cost_usd).toFixed(6)} exact cost` : null,
    summary.exact_cost_usd == null && summary.estimated_cost_usd != null ? `~$${Number(summary.estimated_cost_usd).toFixed(4)} estimated cost` : null,
    `${summary.events.length} source messages`,
    ...(summary.topics || []).map((topic) => `Topic: ${topic}`)
  ].filter(Boolean);
  $("summaryDetails").replaceChildren(...detailValues.map((value) => {
    const chip = document.createElement("span");
    chip.className = "summary-detail-chip";
    chip.textContent = value;
    return chip;
  }));
  $("summaryEvidence").replaceChildren(...summary.events.filter((event) => !isTransientTranscriptEvent(event)).map((event) => {
    const item = document.createElement("div");
    item.className = `message ${event.role}`;
    const role = document.createElement("span");
    role.className = "role";
    role.textContent = `${event.role} · ${formatDateTime(messageTime(event))} · ${event.inclusion_type} · revision ${event.included_revision}`;
    const copy = document.createElement("p");
    copy.textContent = event.text_content;
    item.append(role, copy);
    return item;
  }));
  $("summaryHistory").replaceChildren(...summary.history.map((version) => {
    const row = document.createElement("div");
    row.className = "history-row";
    const label = document.createElement("span");
    label.textContent = `v${version.version} · ${formatDateTime(version.edited_at || version.created_at)}`;
    row.append(label, statusPill(version.status));
    return row;
  }));
}
async function openSummary(id) {
  if (isPreview) {
    renderSummaryDialog(summaries.find((item) => item.id === id) || previewSummary);
    $("summaryDialog").showModal();
    return;
  }
  try {
    const data = await api(`/v1/summaries/${id}?workspaceId=${workspace.id}`);
    renderSummaryDialog(data.summary);
    $("summaryDialog").showModal();
  } catch (error) {
    $("conversationSummaryStatus").textContent = `Summary could not open: ${error.message}`;
  }
}
async function saveSummaryEdit() {
  const summaryText = $("summaryText").value.trim();
  if (!summaryText || !selectedSummary) return;
  $("saveSummary").disabled = true;
  if (isPreview) {
    selectedSummary.summary_text = summaryText;
    selectedSummary.version += 1;
    $("summaryDialog").close();
    renderConversationSummary(selected);
    $("saveSummary").disabled = false;
    return;
  }
  try {
    await api(`/v1/summaries/${selectedSummary.id}?workspaceId=${workspace.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summaryText })
    });
    $("summaryDialog").close();
    summaries = null;
    memoryData = null;
    await loadSummaries();
  } catch (error) {
    $("summaryMeta").textContent = `Could not save: ${error.message}`;
  } finally {
    $("saveSummary").disabled = false;
  }
}
async function removeSummary() {
  if (!selectedSummary || !confirm("Delete this generated summary? The captured conversation will remain.")) return;
  $("deleteSummary").disabled = true;
  if (isPreview) {
    summaries = summaries.filter((item) => item.id !== selectedSummary.id);
    $("summaryDialog").close();
    renderConversationSummary(selected);
    $("deleteSummary").disabled = false;
    return;
  }
  try {
    await api(`/v1/summaries/${selectedSummary.id}?workspaceId=${workspace.id}`, { method: "DELETE" });
    $("summaryDialog").close();
    summaries = null;
    memoryData = null;
    await loadSummaries();
  } catch (error) {
    $("summaryMeta").textContent = `Could not delete: ${error.message}`;
  } finally {
    $("deleteSummary").disabled = false;
  }
}
function evidenceExcerpt(claim) {
  const eventEvidence = claim.evidence.find((item) => item.event)?.event;
  if (!eventEvidence) return "Source checkpoint retained; no message excerpt is available.";
  return `${eventEvidence.role}: ${eventEvidence.text_content}`;
}

function reviewChoiceIcon(kind) {
  return ({
    accept: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 7"/></svg>`,
    reject: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>`,
    defer: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9a4 4 0 1 1 6.8 2.8c-1.5 1.2-2.8 1.7-2.8 3.2M12 19h.01"/></svg>`,
    earlier: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 7-5 5 5 5M5 12h14"/></svg>`,
    newer: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 7 5 5-5 5M5 12h14"/></svg>`,
    both: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="11" height="11" rx="2"/><rect x="9" y="3" width="11" height="11" rx="2"/></svg>`
  })[kind];
}

function reviewFeedback(message, error = false) {
  const status = $("reviewActionStatus");
  status.textContent = message;
  status.classList.toggle("error", error);
  status.classList.toggle("hidden", !message);
}

async function runReviewCardAction(card, direction, button, action) {
  if (card.dataset.saving) return;
  card.dataset.saving = "true";
  card.setAttribute("aria-busy", "true");
  card.classList.add("review-card-saving");
  button.disabled = true;
  let saved = false;
  try {
    saved = await action();
  } catch (error) {
    reviewFeedback(`Choice could not be saved: ${error.message}`, true);
  }
  if (card.isConnected) {
    card.classList.remove("review-card-saving");
    card.removeAttribute("aria-busy");
    delete card.dataset.saving;
    button.disabled = false;
    if (!saved) {
      let feedback = card.querySelector(".review-card-feedback");
      if (!feedback) {
        feedback = document.createElement("p");
        feedback.className = "review-card-feedback";
        feedback.setAttribute("role", "alert");
        card.append(feedback);
      }
      feedback.textContent = $("reviewActionStatus").textContent;
    }
  }
}

function makeFocusReviewAction({ label, caption, kind, className, direction, card, action }) {
  const item = document.createElement("div");
  item.className = "review-focus-action";
  const button = document.createElement("button");
  button.type = "button";
  button.className = `review-focus-action-button ${className}`;
  button.setAttribute("aria-label", label);
  button.innerHTML = reviewChoiceIcon(kind);
  button.onclick = () => runReviewCardAction(card, direction, button, () => action(button));
  const copy = document.createElement("span");
  copy.textContent = caption;
  item.append(button, copy);
  return item;
}

function renderMemory() {
  const unresolved = memoryData.conflicts.filter((item) => item.status === "unresolved");
  const visibleConflicts = unresolved.filter((item) => !deferredConflictIds.has(item.id));
  const actionableTotal = memoryData.conflictQueue?.actionableCandidatePairs ?? unresolved.length;
  const hasOlderCandidates = (memoryData.conflictQueue?.totalCandidatePairs || 0) > (memoryData.conflictQueue?.loadedCandidatePairs || 0);
  const similarCount = memoryData.similarMemoryCount ?? memoryData.similarMemories?.length ?? 0;
  $("similarMemoryStatus").classList.toggle("hidden", similarCount === 0);
  $("similarMemoryStatus").textContent = similarCount ? `${similarCount} similar statement pair${similarCount === 1 ? "" : "s"} kept out of this decision queue. The original memories and sources remain saved.` : "";
  $("conflictCount").textContent = `${actionableTotal}${hasOlderCandidates ? "+" : ""}`;
  $("claimCount").textContent = String(memoryData.claims.length);
  if ($("dashboardReviewState")) $("dashboardReviewState").textContent = `${memoryData.claims.filter((item) => item.status === "provisional").length} proposed · ${actionableTotal}${hasOlderCandidates ? "+" : ""} conflict${actionableTotal === 1 ? "" : "s"}`;
  $("memoryStatus").textContent = memoryData.claims.length
    ? `${memoryData.claims.filter((item) => item.status === "provisional").length} memories awaiting review`
    : "No proposed memories yet.";
  const proposed = memoryData.claims.filter((item) => item.status === "provisional");
  const focusOnConflict = reviewMode === "focus" && visibleConflicts.length > 0;
  const claims = reviewMode === "focus" ? (focusOnConflict ? [] : proposed.slice(0, 1)) : memoryData.claims;
  const conflictQuery = conflictFilters.query.toLowerCase();
  const filteredConflicts = visibleConflicts
    .filter((conflict) => !conflictQuery || [conflict.leftClaim?.display_text, conflict.rightClaim?.display_text].some((value) => String(value || "").toLowerCase().includes(conflictQuery)))
    .sort((left, right) => {
      const delta = new Date(left.created_at || 0).getTime() - new Date(right.created_at || 0).getTime();
      return conflictFilters.sort === "oldest" ? delta : -delta;
    });
  const pageCount = Math.max(1, Math.ceil(filteredConflicts.length / conflictFilters.pageSize));
  conflictFilters.page = Math.min(conflictFilters.page, pageCount);
  const pageStart = (conflictFilters.page - 1) * conflictFilters.pageSize;
  const conflicts = reviewMode === "focus"
    ? (focusOnConflict ? visibleConflicts.slice(0, 1) : [])
    : filteredConflicts.slice(pageStart, pageStart + conflictFilters.pageSize);
  $("conflictQueueControls").classList.toggle("hidden", reviewMode === "focus");
  $("conflictPagination").classList.toggle("hidden", reviewMode === "focus" || filteredConflicts.length <= conflictFilters.pageSize);
  const candidateTotal = memoryData.conflictQueue?.totalCandidatePairs || 0;
  const loadedTotal = memoryData.conflictQueue?.loadedCandidatePairs || unresolved.length;
  $("conflictQueueStatus").textContent = `${filteredConflicts.length} shown · ${actionableTotal}${candidateTotal > loadedTotal ? "+" : ""} awaiting review${candidateTotal > loadedTotal ? " · older pairs load as these are reviewed" : ""}`;
  $("conflictPageStatus").textContent = `Page ${conflictFilters.page} of ${pageCount}`;
  $("conflictPrevious").disabled = conflictFilters.page <= 1;
  $("conflictNext").disabled = conflictFilters.page >= pageCount;
  $("reviewView").classList.toggle("review-focus-mode", reviewMode === "focus");
  $("conflictSection").classList.toggle("hidden", reviewMode === "focus" && !focusOnConflict);
  $("claimSection").classList.toggle("hidden", reviewMode === "focus" && focusOnConflict);
  $("claims").replaceChildren(...(claims.length ? claims.map((claim) => {
    const card = document.createElement("article");
    card.className = "claim-card";
    if (reviewMode === "focus") {
      card.classList.add("review-swipe-card");
      card.tabIndex = -1;
    }
    const head = document.createElement("div");
    head.className = "claim-head";
    const title = document.createElement("h4");
    title.textContent = reviewMode === "focus" ? "Is this true about you?" : claim.display_text;
    head.append(title, statusPill(claim.status));
    const statement = document.createElement("p");
    statement.className = "review-claim-statement";
    statement.textContent = claim.display_text;
    const evidence = document.createElement("blockquote");
    evidence.textContent = evidenceExcerpt(claim);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span>${Math.round(Number(claim.confidence) * 100)}% model confidence</span><span>${claim.reviewHistory.length} review actions</span>`;
    const actions = document.createElement("div");
    actions.className = reviewMode === "focus" ? "review-focus-actions" : "claim-actions";
    if (reviewMode === "focus") {
      actions.append(
        makeFocusReviewAction({ label: "No, this is incorrect", caption: "No", kind: "reject", className: "review-reject", direction: "left", card, action: (button) => reviewMemoryClaim(claim.id, "no", button) }),
        makeFocusReviewAction({ label: "I am not sure", caption: "Not sure", kind: "defer", className: "review-defer", direction: "down", card, action: (button) => reviewMemoryClaim(claim.id, "not_sure", button) }),
        makeFocusReviewAction({ label: "Yes, this is correct", caption: "Yes", kind: "accept", className: "review-accept", direction: "right", card, action: (button) => reviewMemoryClaim(claim.id, "yes", button) })
      );
    } else if (claim.status === "superseded") {
      actions.textContent = "Superseded by a conflict decision. This memory cannot be reviewed here.";
    } else {
      for (const [decision, label, className] of [["yes", "Yes, correct", "choice-yes"], ["no", "No, incorrect", "choice-no"], ["not_sure", "Not sure", "choice-unsure"]]) {
        const button = document.createElement("button");
        button.className = className;
        button.textContent = label;
        button.onclick = () => reviewMemoryClaim(claim.id, decision, button);
        actions.append(button);
      }
    }
    if (reviewMode === "focus") {
      const progress = document.createElement("div");
      progress.className = "review-card-progress";
      progress.innerHTML = `<span><i></i>${actionableTotal + proposed.length}${hasOlderCandidates ? "+" : ""} recent decision${actionableTotal + proposed.length === 1 ? "" : "s"}</span><span>Choose what Sherry should remember</span>`;
      card.append(progress, head, statement, evidence, meta, actions);
    } else {
      card.append(head, evidence, meta, actions);
    }
    return card;
  }) : [emptyState(reviewMode === "focus" ? "You are caught up. There are no more proposed memories waiting for review." : "Proposed memories will appear after a summary extracts reusable facts or preferences.")]));
  $("conflicts").replaceChildren(...(conflicts.length ? conflicts.map((conflict) => {
    const card = document.createElement("article");
    card.className = "conflict-card";
    if (reviewMode === "focus") {
      card.classList.add("review-swipe-card");
      card.tabIndex = -1;
    }
    const head = document.createElement("div");
    head.className = "claim-head";
    const title = document.createElement("h4");
    title.textContent = conflict.status === "unresolved" ? "Do these memories disagree?" : `Conflict ${conflict.status}`;
    head.append(title, statusPill(conflict.status));
    const guidance = document.createElement("p");
    guidance.className = "conflict-guidance muted";
    guidance.textContent = conflict.classification?.reason || "Compare the wording and sources before choosing.";
    const repeated = Number(conflict.repeated_count || 1);
    const repeatNote = document.createElement("p");
    repeatNote.className = "conflict-repeat-note";
    repeatNote.textContent = repeated > 1 ? `${repeated} identical comparisons grouped. One choice covers them together.` : "";
    const pair = document.createElement("div");
    pair.className = "conflict-pair";
    for (const [version, label, claim, resolution, direction] of [["earlier", "Earlier memory", conflict.leftClaim, "keep_left", "left"], ["newer", "Newer memory", conflict.rightClaim, "keep_right", "right"]]) {
      const option = document.createElement("div");
      option.className = `conflict-option conflict-option-${version}`;
      const small = document.createElement("small");
      const number = document.createElement("span");
      number.className = "memory-version-number";
      number.textContent = version === "earlier" ? "01" : "02";
      const versionLabel = document.createElement("span");
      versionLabel.textContent = label;
      small.append(number, versionLabel);
      const copy = document.createElement("span");
      copy.className = "conflict-option-copy";
      copy.textContent = claim?.display_text || `This ${version} memory was removed from Sherry and can no longer be selected.`;
      const source = document.createElement("small");
      source.className = "conflict-option-source";
      source.textContent = claim ? `${claim.conversation?.title || "Source chat unavailable"} · ${claim.observed_at ? formatDateTime(claim.observed_at) : "Source time unavailable"}` : "Source unavailable";
      option.append(small, copy, source);
      if (conflict.status === "unresolved") {
        const choose = document.createElement("button");
        choose.type = "button";
        choose.className = `memory-choice-button memory-choice-${version}`;
        choose.innerHTML = `${reviewChoiceIcon(version)}<span>Keep ${version}</span>`;
        choose.disabled = !claim;
        choose.onclick = () => runReviewCardAction(card, direction, choose, () => resolveMemoryConflict(conflict.id, resolution, choose));
        option.append(choose);
      }
      pair.append(option);
    }
    if (reviewMode === "focus") {
      const progress = document.createElement("div");
      progress.className = "review-card-progress";
      progress.innerHTML = `<span><i></i>${actionableTotal + proposed.length}${hasOlderCandidates ? "+" : ""} recent decision${actionableTotal + proposed.length === 1 ? "" : "s"}</span>`;
      card.append(progress, head, guidance);
      if (repeated > 1) card.append(repeatNote);
      card.append(pair);
    } else {
      card.append(head, guidance);
      if (repeated > 1) card.append(repeatNote);
      card.append(pair);
    }
    if (conflict.status === "unresolved") {
      const actions = document.createElement("div");
      actions.className = `conflict-actions${reviewMode === "focus" ? " conflict-secondary-actions" : ""}`;
      for (const [resolution, label, kind, direction] of [["keep_both", "Keep both", "both", "up"], ["dismiss", "Decide later", "defer", "down"]]) {
        const button = document.createElement("button");
        button.className = resolution === "dismiss" ? "choice-unsure" : "secondary";
        button.innerHTML = `${reviewChoiceIcon(kind)}<span>${label}</span>`;
        button.onclick = () => runReviewCardAction(card, direction, button, () => resolution === "dismiss"
          ? deferMemoryConflict(conflict.id)
          : resolveMemoryConflict(conflict.id, resolution, button));
        actions.append(button);
      }
      card.append(actions);
    }
    return card;
  }) : [emptyState("No conflicting memories have been detected.")]));
}

function personalMemoryDrafts() {
  if (!isPreview) return personalMemoryEntries;
  try {
    const drafts = JSON.parse(localStorage.getItem("memory_personal_drafts") || "[]");
    let changed = false;
    const normalized = drafts.map((draft, index) => {
      const id = draft.id || `legacy-${index}-${String(draft.createdAt || "").replaceAll(/[^0-9]/g, "")}`;
      const fieldKey = draft.fieldKey || `custom:${id}`;
      const label = draft.label || "Custom entry";
      if (!draft.id || !draft.fieldKey || !draft.label) changed = true;
      return { ...draft, id, fieldKey, label, isCustom: draft.isCustom ?? fieldKey.startsWith("custom:") };
    });
    if (changed) localStorage.setItem("memory_personal_drafts", JSON.stringify(normalized));
    return normalized;
  } catch { return []; }
}

const builtInMemoryCategories = [
  { name: "Basic information", description: "Name, location, language, and other basics", defaultFields: [
    { key: "name", label: "Name", placeholder: "How should Sherry address you?" },
    { key: "location", label: "Location", placeholder: "City, region, or country" },
    { key: "language", label: "Preferred language", placeholder: "Language and regional preference" },
    { key: "timezone", label: "Time zone", placeholder: "For example: Eastern Time" }
  ] },
  { name: "Personal", description: "Preferences, routines, and interests", defaultFields: [
    { key: "interests", label: "Interests", placeholder: "Topics, hobbies, and activities you enjoy" },
    { key: "routine", label: "Daily routine", placeholder: "Helpful patterns in your day" },
    { key: "communication", label: "Communication preference", placeholder: "How you prefer information to be shared" },
    { key: "priorities", label: "Personal priorities", placeholder: "What matters most right now" }
  ] },
  { name: "Professional", description: "Work, role, and communication preferences", defaultFields: [
    { key: "role", label: "Role", placeholder: "Your role or area of work" },
    { key: "organization", label: "Organization or team", placeholder: "Company, studio, or team" },
    { key: "expertise", label: "Areas of expertise", placeholder: "Skills and subject areas" },
    { key: "work-style", label: "Work preferences", placeholder: "How you like to plan and collaborate" }
  ] },
  { name: "Finance", description: "Optional financial context", defaultFields: [
    { key: "currency", label: "Preferred currency", placeholder: "For example: USD" },
    { key: "goals", label: "Financial goals", placeholder: "Optional goals Sherry should keep in mind" },
    { key: "budget", label: "Budget preferences", placeholder: "Typical ranges or spending preferences" },
    { key: "risk", label: "Risk preference", placeholder: "Conservative, balanced, or growth-oriented" }
  ] },
  { name: "Health", description: "Optional health context", defaultFields: [
    { key: "diet", label: "Dietary preferences", placeholder: "Dietary needs or preferences" },
    { key: "allergies", label: "Allergies", placeholder: "Optional allergies or sensitivities" },
    { key: "accessibility", label: "Accessibility needs", placeholder: "Adjustments that make experiences easier" },
    { key: "wellbeing", label: "Wellbeing preferences", placeholder: "Optional routines or considerations" }
  ] }
];

const customCategoryDefaultFields = [
  { key: "overview", label: "Overview", placeholder: "What should Sherry know about this category?" },
  { key: "preferences", label: "Preferences", placeholder: "Any preferences Sherry should remember" }
];

function customMemoryCategories() {
  if (!isPreview) return personalMemoryCustomCategories;
  try {
    return JSON.parse(localStorage.getItem("memory_personal_categories") || "[]").map((category, index) => typeof category === "string"
      ? { id: `legacy-category-${index}`, name: category, description: "Custom personal memory category" }
      : category);
  } catch { return []; }
}

function allMemoryCategories() {
  return [
    ...builtInMemoryCategories.map((category) => ({ ...category, custom: false })),
    ...customMemoryCategories().map((category) => ({ ...category, custom: true, defaultFields: customCategoryDefaultFields }))
  ];
}

function saveCustomMemoryCategories(categories) {
  if (!isPreview) { personalMemoryCustomCategories = categories; return; }
  localStorage.setItem("memory_personal_categories", JSON.stringify(categories));
}

function savePersonalMemoryDrafts(drafts) {
  if (!isPreview) { personalMemoryEntries = drafts; return; }
  localStorage.setItem("memory_personal_drafts", JSON.stringify(drafts));
}

function renderMemoryCategoryOptions(selectedCategory = null) {
  const currentValue = selectedCategory || $("memoryCategory").value;
  $("memoryCategory").replaceChildren(...allMemoryCategories().map((category) => {
    const option = document.createElement("option");
    option.value = category.name;
    option.textContent = category.name;
    return option;
  }));
  if (currentValue && [...$("memoryCategory").options].some((option) => option.value === currentValue)) $("memoryCategory").value = currentValue;
}

function openPersonalMemoryEditor(categoryName, content) {
  const drafts = personalMemoryDrafts();
  const categoryDrafts = drafts.filter((item) => item.category === categoryName);
  const category = allMemoryCategories().find((item) => item.name === categoryName);
  if (!category) return;
  content.replaceChildren();
  const editor = document.createElement("form");
  editor.className = "memory-category-editor";
  const guidance = document.createElement("p");
  guidance.className = "memory-editor-guidance";
  guidance.textContent = "Complete the suggested fields or add your own field and value.";
  const rows = document.createElement("div");
  rows.className = "memory-field-list";

  const makeRow = ({ fieldKey, label, placeholder, value = "", id = "", isCustom = false }) => {
    const row = document.createElement("div");
    row.className = "memory-edit-row";
    row.dataset.fieldKey = fieldKey;
    row.dataset.id = id;
    row.dataset.custom = String(isCustom);
    const labelField = document.createElement(isCustom ? "input" : "span");
    labelField.className = "memory-edit-label";
    if (isCustom) {
      labelField.value = label;
      labelField.maxLength = 80;
      labelField.placeholder = "Field name";
      labelField.setAttribute("aria-label", `Custom field name in ${categoryName}`);
    } else {
      labelField.textContent = label;
    }
    const input = document.createElement("input");
    input.className = "memory-edit-value";
    input.value = value;
    input.maxLength = 1000;
    input.placeholder = placeholder;
    input.setAttribute("aria-label", `${label} in ${categoryName}`);
    row.append(labelField, input);
    if (isCustom) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "quiet memory-remove-field";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${label || "custom field"}`);
      remove.onclick = () => row.remove();
      row.append(remove);
    }
    rows.append(row);
  };

  category.defaultFields.forEach((field) => {
    const draft = categoryDrafts.find((item) => item.fieldKey === `default:${field.key}`);
    makeRow({ fieldKey: `default:${field.key}`, label: field.label, placeholder: field.placeholder, value: draft?.content || "", id: draft?.id || "" });
  });
  categoryDrafts.filter((item) => item.isCustom || item.fieldKey.startsWith("custom:")).forEach((draft) => {
    makeRow({ fieldKey: draft.fieldKey, label: draft.label, placeholder: "Enter information", value: draft.content, id: draft.id, isCustom: true });
  });

  const addField = document.createElement("button");
  addField.type = "button";
  addField.className = "quiet memory-add-field";
  addField.textContent = "+ Add custom field";
  addField.onclick = () => {
    makeRow({ fieldKey: `custom:${crypto.randomUUID?.() || Date.now()}`, label: "", placeholder: "Enter information", isCustom: true });
    rows.lastElementChild?.querySelector("input")?.focus();
  };
  const actions = document.createElement("div");
  actions.className = "memory-editor-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "Cancel";
  cancel.onclick = () => renderPersonalMemoryCategories();
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save changes";
  actions.append(cancel, save);
  editor.append(guidance, rows, addField, actions);
  editor.onsubmit = async (event) => {
    event.preventDefault();
    const otherDrafts = drafts.filter((item) => item.category !== categoryName);
    const nextDrafts = [...rows.querySelectorAll(".memory-edit-row")].flatMap((row, index) => {
      const value = row.querySelector(".memory-edit-value").value.trim();
      if (!value) return [];
      const isCustom = row.dataset.custom === "true";
      const label = isCustom ? row.querySelector(".memory-edit-label").value.trim() : row.querySelector(".memory-edit-label").textContent;
      if (isCustom && !label) return [];
      const previous = categoryDrafts.find((item) => item.id === row.dataset.id || item.fieldKey === row.dataset.fieldKey);
      return [{
        id: previous?.id || (isPreview ? (crypto.randomUUID?.() || `${Date.now()}-${index}`) : ""),
        category: categoryName,
        fieldKey: row.dataset.fieldKey,
        label,
        content: value,
        isCustom,
        createdAt: previous?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }];
    });
    if (isPreview) {
      savePersonalMemoryDrafts([...otherDrafts, ...nextDrafts]);
      renderPersonalMemoryCategories();
      return;
    }
    save.disabled = true;
    guidance.textContent = "Saving changes…";
    try {
      const retainedIds = new Set(nextDrafts.map((item) => item.id).filter(Boolean));
      await Promise.all(categoryDrafts.filter((item) => item.id && !retainedIds.has(item.id)).map((item) => api(`/v1/personal-memory/${item.id}?workspaceId=${workspace.id}`, { method: "DELETE" })));
      const saved = await Promise.all(nextDrafts.map(async (item) => {
        const payload = { kind: "entry", category: item.category, fieldKey: item.fieldKey, label: item.label, content: item.content, isCustom: item.isCustom };
        const response = await api(item.id ? `/v1/personal-memory/${item.id}?workspaceId=${workspace.id}` : `/v1/personal-memory?workspaceId=${workspace.id}`, {
          method: item.id ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        return response.record;
      }));
      personalMemoryEntries = [...otherDrafts, ...saved];
      renderPersonalMemoryCategories();
    } catch (error) {
      guidance.textContent = `Could not save: ${error.message}`;
      save.disabled = false;
    }
  };
  content.append(editor);
  requestAnimationFrame(() => editor.querySelector(".memory-edit-value")?.focus());
}

async function deletePersonalMemoryCategory(categoryName) {
  if (!confirm(`Delete “${categoryName}” and all information saved inside it?`)) return;
  try {
    if (!isPreview) {
      const category = personalMemoryCustomCategories.find((item) => item.name === categoryName);
      if (category?.id) await api(`/v1/personal-memory/${category.id}?workspaceId=${workspace.id}`, { method: "DELETE" });
    }
    saveCustomMemoryCategories(customMemoryCategories().filter((category) => category.name !== categoryName));
    savePersonalMemoryDrafts(personalMemoryDrafts().filter((draft) => draft.category !== categoryName));
    renderPersonalMemoryCategories();
  } catch (error) {
    alert(`Could not delete the category: ${error.message}`);
  }
}

function renderPersonalMemoryCategories() {
  const container = $("personalMemoryCategories");
  if (!container) return;
  const drafts = personalMemoryDrafts();
  renderMemoryCategoryOptions();
  container.replaceChildren(...allMemoryCategories().map((category) => {
    const section = document.createElement("details");
    section.className = "memory-category";
    section.open = true;
    section.dataset.category = category.name;
    const categoryDrafts = drafts.filter((item) => item.category === category.name);
    const customFieldCount = categoryDrafts.filter((item) => item.isCustom || item.fieldKey.startsWith("custom:")).length;
    const totalFieldCount = category.defaultFields.length + customFieldCount;
    const summary = document.createElement("summary");
    summary.innerHTML = `<span class="memory-category-title"><strong></strong><small></small></span><span class="category-count">${categoryDrafts.length} of ${totalFieldCount} saved</span><svg class="accordion-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>`;
    summary.querySelector("strong").textContent = category.name;
    summary.querySelector("small").textContent = category.description;
    const content = document.createElement("div");
    content.className = "memory-category-content";
    const list = document.createElement("div");
    list.className = "memory-field-list";
    category.defaultFields.forEach((field) => {
      const item = categoryDrafts.find((draft) => draft.fieldKey === `default:${field.key}`);
      const row = document.createElement("div");
      row.className = `memory-field${item ? "" : " memory-field-empty"}`;
      const copy = document.createElement("div");
      copy.className = "memory-field-copy";
      const label = document.createElement("strong");
      label.textContent = field.label;
      const value = document.createElement("p");
      value.textContent = item?.content || field.placeholder;
      copy.append(label, value);
      row.append(copy);
      list.append(row);
    });
    categoryDrafts.filter((item) => item.isCustom || item.fieldKey.startsWith("custom:")).forEach((item) => {
        const row = document.createElement("div");
        row.className = "memory-field";
        const copy = document.createElement("div");
        copy.className = "memory-field-copy";
        const label = document.createElement("strong");
        label.textContent = item.label;
        const value = document.createElement("p");
        value.textContent = item.content;
        copy.append(label, value);
        const actions = document.createElement("div");
        actions.className = "memory-field-actions";
        const remove = document.createElement("button");
        remove.className = "quiet";
        remove.type = "button";
        remove.textContent = "Delete";
        remove.onclick = async () => {
          try {
            if (!isPreview && item.id) await api(`/v1/personal-memory/${item.id}?workspaceId=${workspace.id}`, { method: "DELETE" });
            savePersonalMemoryDrafts(personalMemoryDrafts().filter((draft) => draft !== item && draft.id !== item.id));
            renderPersonalMemoryCategories();
          } catch (error) {
            alert(`Could not delete this memory: ${error.message}`);
          }
        };
        actions.append(remove);
        row.append(copy, actions);
        list.append(row);
      });
    const actions = document.createElement("div");
    actions.className = "memory-category-actions";
    if (category.custom) {
      const removeCategory = document.createElement("button");
      removeCategory.className = "quiet memory-delete-category";
      removeCategory.type = "button";
      removeCategory.textContent = "Delete category";
      removeCategory.onclick = () => deletePersonalMemoryCategory(category.name);
      actions.append(removeCategory);
    }
    const update = document.createElement("button");
    update.className = "secondary";
    update.type = "button";
    update.textContent = "Update";
    update.onclick = () => openPersonalMemoryEditor(category.name, content);
    actions.append(update);
    content.append(list, actions);
    section.append(summary, content);
    return section;
  }));
}

async function addPersonalMemory(event) {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('[type="submit"]');
  $("memoryFormStatus").textContent = "";
  const id = isPreview ? (crypto.randomUUID?.() || String(Date.now())) : "";
  const draft = { id, category: $("memoryCategory").value, fieldKey: `custom:${id}`, label: $("memoryLabel").value.trim(), content: $("memoryText").value.trim(), isCustom: true, createdAt: new Date().toISOString() };
  if (!draft.content) return;
  const drafts = personalMemoryDrafts();
  submit.disabled = true;
  try {
    if (isPreview) drafts.push(draft);
    else {
      const key = `custom:${crypto.randomUUID?.() || Date.now()}`;
      const response = await api(`/v1/personal-memory?workspaceId=${workspace.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "entry", category: draft.category, fieldKey: key, label: draft.label, content: draft.content, isCustom: true }) });
      drafts.push(response.record);
    }
    savePersonalMemoryDrafts(drafts);
    renderPersonalMemoryCategories();
    $("memoryDialog").close();
    $("memoryLabel").value = "";
    $("memoryText").value = "";
  } catch (error) {
    $("memoryFormStatus").textContent = `Could not add this memory: ${error.message}`;
  } finally {
    submit.disabled = false;
  }
}

async function addPersonalMemoryCategory(event) {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('[type="submit"]');
  $("categoryFormStatus").textContent = "";
  const name = $("categoryName").value.trim();
  const description = $("categoryDescription").value.trim();
  if (!name) return;
  const existing = allMemoryCategories().some((category) => category.name.toLowerCase() === name.toLowerCase());
  submit.disabled = true;
  try {
    if (!existing) {
      let category = { id: crypto.randomUUID?.() || String(Date.now()), name, description: description || "Custom personal memory category" };
      if (!isPreview) {
        const response = await api(`/v1/personal-memory?workspaceId=${workspace.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "category", name, description }) });
        category = response.record;
      }
      saveCustomMemoryCategories([...customMemoryCategories(), category]);
    }
    $("categoryDialog").close();
    $("categoryName").value = "";
    $("categoryDescription").value = "";
    renderPersonalMemoryCategories();
  } catch (error) {
    $("categoryFormStatus").textContent = `Could not create this category: ${error.message}`;
  } finally {
    submit.disabled = false;
  }
}

function memoryGraphElements() {
  const visibleConversations = conversations;
  const elements = visibleConversations.map((conversation) => ({
    data: {
      id: `conversation-${conversation.id}`,
      sourceId: conversation.id,
      label: conversation.title || "Untitled conversation",
      type: "conversation",
      provider: String(conversation.provider || "unknown").toLowerCase(),
      description: `${providerLabel(conversation.provider)} chat · ${conversationActivityLabel(conversation)}`
    }
  }));
  const links = SherryGraphConnections.build(visibleConversations, summaries || []);
  for (const link of links) elements.push({ data: {
    id: `edge-${link.sourceId}-${link.targetId}`,
    source: `conversation-${link.sourceId}`,
    target: `conversation-${link.targetId}`,
    relationship: link.relationship
  } });
  const neighbors = new Map(visibleConversations.map((conversation) => [conversation.id, new Set()]));
  for (const link of links) {
    neighbors.get(link.sourceId)?.add(link.targetId);
    neighbors.get(link.targetId)?.add(link.sourceId);
  }
  const ordered = [];
  const visited = new Set();
  const seeds = [...visibleConversations].sort((left, right) =>
    (neighbors.get(right.id)?.size || 0) - (neighbors.get(left.id)?.size || 0));
  for (const seed of seeds) {
    if (visited.has(seed.id)) continue;
    const queue = [seed.id];
    visited.add(seed.id);
    while (queue.length) {
      const id = queue.shift();
      ordered.push(id);
      for (const next of neighbors.get(id) || []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
  }
  const columns = Math.min(8, Math.max(3, Math.ceil(Math.sqrt(ordered.length))));
  const positions = new Map(ordered.map((id, index) => [id, {
    x: (index % columns) * 252,
    y: Math.floor(index / columns) * 164
  }]));
  for (const element of elements) {
    if (element.data.sourceId) element.position = positions.get(element.data.sourceId);
  }
  $("mapConnectionCount").textContent = `${links.length} meaningful connection${links.length === 1 ? "" : "s"} across ${visibleConversations.length} chat${visibleConversations.length === 1 ? "" : "s"}`;
  if (!links.length && visibleConversations.length) $("mapSelection").textContent = "No supported connections yet. Links appear when chat titles, summaries, or saved memories provide clear shared context.";
  return elements;
}

function focusGraphNode(node, { initial = false } = {}) {
  if (!memoryGraph || !node?.length) return;
  const neighbors = node.neighborhood("node").toArray()
    .sort((left, right) => right.degree() - left.degree())
    .slice(0, 5);
  const focus = node.union(memoryGraph.collection(neighbors));
  memoryGraph.fit(focus, 100);
  const readableZoom = Math.min(initial ? 1.05 : 1.2, Math.max(.85, memoryGraph.zoom()));
  memoryGraph.zoom(readableZoom);
  memoryGraph.center(node);
  if (initial) $("mapSelection").textContent = `Starting near “${node.data("label")}” and its connected chats. Drag to explore the rest; Find jumps to any chat.`;
}

function initMemoryGraph() {
  const container = $("memoryGraph");
  if (!container || container.offsetWidth === 0) return;
  if (!$("mapOpenMatch")) {
    const open = document.createElement("button");
    open.id = "mapOpenMatch";
    open.type = "button";
    open.className = "secondary map-open-match hidden";
    open.textContent = "Open found chat";
    open.onclick = () => { if (mapMatchId) void openConversation(mapMatchId); };
    document.querySelector(".map-toolbar-actions")?.append(open);
  }
  $("mapFit").textContent = "Overview";
  if (typeof cytoscape !== "function") {
    container.textContent = "The interactive graph library could not load.";
    return;
  }
  if (memoryGraph) memoryGraph.destroy();
  mapMatchId = null;
  $("mapOpenMatch").classList.add("hidden");
  try {
    memoryGraph = cytoscape({
      container,
      elements: memoryGraphElements(),
    minZoom: .15,
    maxZoom: 4,
    zoomingEnabled: true,
    userZoomingEnabled: true,
    panningEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
    style: [
      { selector: "node", style: { "background-color": "#ffffff", "border-color": "rgba(0, 0, 0, .14)", "border-width": 1, "color": "#080808", "font-family": "Inter, system-ui, sans-serif", "font-size": 14, "min-zoomed-font-size": 9, "font-weight": 500, "height": 64, "label": "data(label)", "padding": 12, "shape": "round-rectangle", "text-halign": "center", "text-max-width": 132, "text-valign": "center", "text-wrap": "wrap", "width": 168 } },
      { selector: "node[provider = 'chatgpt']", style: { "border-color": "#111111", "border-width": 1.5 } },
      { selector: "node[provider = 'claude']", style: { "background-color": "#f5f1ed" } },
      { selector: "node[provider = 'gemini']", style: { "background-color": "#f2f1ff" } },
      { selector: "node:selected", style: { "background-color": "#f2f1ff", "border-color": "#7170ff", "border-width": 2 } },
      { selector: "edge", style: { "curve-style": "bezier", "line-color": "#7170ff", "line-style": "solid", "opacity": .62, "target-arrow-shape": "none", "width": 1.75 } },
      { selector: "edge:selected", style: { "line-color": "#7170ff", "opacity": 1, "width": 2 } }
    ],
      layout: { name: "preset", fit: false }
    });
  } catch (error) {
    console.error("Memory graph could not initialize", error);
    container.replaceChildren(metricEmpty("The relationship graph could not be drawn. Your conversations are still available in Chat Memory."));
    return;
  }
  let framed = false;
  const frameInitialCluster = () => {
    if (framed || !memoryGraph?.nodes().length) return;
    framed = true;
    if (memoryGraph.nodes().length <= 12) {
      memoryGraph.fit(undefined, 80);
      $("mapSelection").textContent = "All chats are in view. Drag to pan, scroll or pinch to zoom, or select a chat to open it.";
      return;
    }
    const hub = memoryGraph.nodes().toArray().sort((left, right) => right.degree() - left.degree())[0];
    focusGraphNode(hub, { initial: true });
  };
  memoryGraph.one("layoutstop", frameInitialCluster);
  // The layout can stop before this listener is registered. Wait a tick for
  // synchronous layouts, but never frame while an animated layout is moving.
  requestAnimationFrame(frameInitialCluster);
  memoryGraph.on("tap", "node", (event) => {
    const node = event.target;
    $("mapSelection").textContent = node.data("description");
    if (node.data("type") === "conversation") void openConversation(node.data("sourceId"));
  });
  memoryGraph.on("tap", "edge", (event) => {
    const edge = event.target;
    $("mapSelection").textContent = edge.data("relationship");
  });
  memoryGraph.on("tap", (event) => {
    if (event.target === memoryGraph) $("mapSelection").textContent = "Drag to explore, scroll or pinch to zoom. Select a chat to open it, or a line to see why those chats connect.";
  });
}

function zoomMemoryGraph(factor) {
  if (!memoryGraph) return;
  const container = $("memoryGraph");
  memoryGraph.zoom({ level: Math.max(memoryGraph.minZoom(), Math.min(memoryGraph.maxZoom(), memoryGraph.zoom() * factor)), renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 } });
}

function findConversationOnMap() {
  if (!memoryGraph) return;
  const query = $("mapSearch").value.trim().toLowerCase();
  if (!query) return;
  const matches = memoryGraph.nodes().filter((node) => String(node.data("label")).toLowerCase().includes(query));
  if (!matches.length) {
    mapMatchId = null;
    $("mapOpenMatch").classList.add("hidden");
    $("mapSelection").textContent = `No chat title matches “${$("mapSearch").value.trim()}”.`;
    return;
  }
  const node = matches[0];
  mapMatchId = node.data("sourceId");
  $("mapOpenMatch").classList.remove("hidden");
  memoryGraph.elements().unselect();
  node.select();
  focusGraphNode(node);
  $("mapSelection").textContent = `${node.data("label")} · ${matches.length} matching chat${matches.length === 1 ? "" : "s"}. Showing the closest connected chats; select this node to open its conversation.`;
}

function updateMapFullscreenState() {
  const map = $("connectionMap");
  const button = $("mapFullscreenButton");
  if (!map || !button) return;
  const expanded = document.fullscreenElement === map || map.classList.contains("map-fullscreen-fallback");
  button.setAttribute("aria-label", expanded ? "Exit full screen memory graph" : "Open memory graph in full screen");
  button.innerHTML = expanded
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"/></svg><span>Exit full screen</span>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg><span>Full screen</span>`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!memoryGraph) return;
    const extent = memoryGraph.extent();
    const center = { x: (extent.x1 + extent.x2) / 2, y: (extent.y1 + extent.y2) / 2 };
    memoryGraph.resize();
    const canvas = $("memoryGraph");
    memoryGraph.pan({ x: canvas.clientWidth / 2 - center.x * memoryGraph.zoom(), y: canvas.clientHeight / 2 - center.y * memoryGraph.zoom() });
  }));
}

async function toggleMapFullscreen() {
  const map = $("connectionMap");
  if (!map) return;
  if (map.classList.contains("map-fullscreen-fallback")) {
    map.classList.remove("map-fullscreen-fallback");
    document.body.classList.remove("map-fullscreen-active");
    updateMapFullscreenState();
    return;
  }
  if (document.fullscreenElement === map) {
    await document.exitFullscreen();
    return;
  }
  try {
    if (!map.requestFullscreen) throw new Error("Fullscreen API unavailable");
    await map.requestFullscreen();
  } catch {
    map.classList.add("map-fullscreen-fallback");
    document.body.classList.add("map-fullscreen-active");
    updateMapFullscreenState();
  }
}
async function loadMemory() {
  $("memoryStatus").textContent = "Loading memories…";
  try {
    memoryData = await api(`/v1/memories?workspaceId=${workspace.id}`);
    renderMemory();
    return true;
  } catch (error) {
    $("memoryStatus").textContent = `Memory review could not load: ${error.message}`;
    return false;
  }
}
async function reviewMemoryClaim(id, decision, button) {
  button.disabled = true;
  reviewFeedback("Saving your memory review…");
  if (isPreview) {
    const claim = memoryData.claims.find((item) => item.id === id);
    if (claim) {
      claim.status = decision === "yes" ? "confirmed" : decision === "no" ? "rejected" : "provisional";
      claim.reviewHistory.push({ decision });
      renderMemory();
    }
    button.disabled = false;
    reviewFeedback("Memory review saved.");
    return true;
  }
  try {
    await api(`/v1/memories/${id}/review?workspaceId=${workspace.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision })
    });
    const refreshed = await loadMemory();
    reviewFeedback(refreshed ? "Memory review saved." : "Memory review saved, but the list could not refresh. Reload the page to see the new state.", !refreshed);
    return true;
  } catch (error) {
    reviewFeedback(`Review could not be saved: ${error.message}`, true);
    return false;
  } finally {
    button.disabled = false;
  }
}
function deferMemoryConflict(id) {
  deferredConflictIds.add(id);
  renderMemory();
  reviewFeedback("Skipped for now. No memory was changed; this comparison returns when you reload the page.");
  return true;
}
async function resolveMemoryConflict(id, resolution, button) {
  button.disabled = true;
  reviewFeedback("Saving your conflict choice…");
  if (isPreview) {
    const conflict = memoryData.conflicts.find((item) => item.id === id);
    if (conflict) conflict.status = resolution === "dismiss" ? "dismissed" : "resolved";
    renderMemory();
    button.disabled = false;
    reviewFeedback("Choice saved. Matching comparisons were handled together.");
    return true;
  }
  try {
    const result = await api(`/v1/conflicts/${id}/resolve?workspaceId=${workspace.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution })
    });
    const refreshed = await loadMemory();
    if (!refreshed) {
      memoryData = null;
      $("conflicts").replaceChildren(emptyState("Choice saved, but the latest conflict list could not load. Reload the page before making another choice."));
      $("conflictCount").textContent = "—";
      $("conflictQueueStatus").textContent = "Reload required to see the current conflict queue.";
    }
    const handled = Number(result?.conflict?.affectedConflicts || 1);
    reviewFeedback(refreshed
      ? `Choice saved. ${handled} matching comparison${handled === 1 ? "" : "s"} handled.`
      : `Choice saved and ${handled} comparison${handled === 1 ? "" : "s"} handled, but the list could not refresh. Reload the page to see the latest state.`, !refreshed);
    return true;
  } catch (error) {
    reviewFeedback(`Conflict could not be resolved: ${error.message}`, true);
    return false;
  } finally {
    button.disabled = false;
  }
}

function summaryForConversation(conversation) {
  return (summaries || []).find((summary) => summary.conversation?.id === conversation.id || summary.conversation_id === conversation.id || summary.conversation?.title === conversation.title);
}

function renderConversationSummary(conversation) {
  const summary = summaryForConversation(conversation);
  const content = $("conversationSummaryContent");
  if (!summary) {
    $("conversationSummaryVersion").textContent = "Not created";
    $("conversationSummaryVersion").className = "status-pill provisional";
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "This conversation does not have a summary yet.";
    content.replaceChildren(empty);
    return;
  }
  $("conversationSummaryVersion").textContent = `v${summary.version}`;
  $("conversationSummaryVersion").className = "status-pill confirmed";
  const copy = document.createElement("p");
  copy.textContent = summary.summary_text;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `<span>Created ${summary.created_at ? formatDateTime(summary.created_at) : "time unavailable"}</span>`;
  const actions = document.createElement("div");
  actions.className = "summary-inline-actions";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "secondary";
  open.textContent = "View and edit summary";
  open.onclick = () => openSummary(summary.id);
  actions.append(open);
  content.replaceChildren(copy, meta, actions);
}

async function summarizeSelectedConversation() {
  if (!selected) return;
  $("summarizeConversation").disabled = true;
  $("conversationSummaryStatus").textContent = "Summarizing only this conversation…";
  if (isPreview) {
    $("conversationSummaryStatus").textContent = "Preview complete: only new messages in this conversation would be sent to the selected summarizer.";
    $("summarizeConversation").disabled = false;
    return;
  }
  try {
    const result = await api(`/v1/summaries/run?workspaceId=${workspace.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: selected.id })
    });
    const job = result.jobs?.[0];
    if (result.status === "protected") {
      $("conversationSummaryStatus").textContent = "Sherry protected you from repeating the same failed model call. Save a changed model, provider, or replacement API key in Settings, then retry.";
      await loadDiagnostics();
    } else if (result.status === "no_work") {
      $("conversationSummaryStatus").textContent = "This conversation has no unsummarized changes.";
    } else if (job?.status === "completed") {
      memoryData = null;
      const refreshed = await loadSummaries();
      render();
      $("conversationSummaryStatus").textContent = refreshed
        ? `Summary version ${job.version || 1} saved.`
        : `Summary version ${job.version || 1} saved, but the panel could not refresh. Reopen this conversation to see it.`;
    } else if (job?.retryScheduled) {
      $("conversationSummaryStatus").textContent = "The provider is temporarily unavailable. Sherry will retry safely.";
    } else {
      $("conversationSummaryStatus").textContent = job?.errorDetail || "The summary did not complete. Check Diagnostics for details.";
    }
  } catch (error) {
    $("conversationSummaryStatus").textContent = `Could not summarize: ${error.message}`;
  } finally {
    $("summarizeConversation").disabled = false;
  }
}
function renderTranscriptMessages(sourceEventId) {
  if (!selected) return;
  const highlightedId = sourceEventId === undefined
    ? $("messages").querySelector(".message-source-target")?.dataset.eventId
    : sourceEventId;
  const events = sortedTranscriptEvents(
    (selected.events || []).filter((event) => !isTransientTranscriptEvent(event)),
    $("transcriptSort").value
  );
  $("messages").replaceChildren(...events.map((event) => {
    const message = document.createElement("div");
    message.className = `message ${event.role}`;
    if (event.id != null) message.dataset.eventId = String(event.id);
    if (highlightedId != null && String(event.id) === String(highlightedId)) message.classList.add("message-source-target");
    const role = document.createElement("span");
    role.className = "role";
    role.textContent = `${event.role} · ${event.message_timestamp ? "Sent" : "Captured"} ${formatDateTime(messageTime(event))}`;
    const copy = document.createElement("p");
    copy.textContent = event.text_content;
    message.append(role, copy);
    return message;
  }));
}

async function openConversation(id, options = {}) {
  const data = isPreview ? { conversation: conversations.find((item) => item.id === id) } : await api(`/v1/conversations/${id}?workspaceId=${workspace.id}`);
  selected = data.conversation;
  if (!selected) return;
  $("detailProvider").replaceChildren(providerIcon(selected.provider));
  $("detailTitle").textContent = selected.title;
  $("detailUpdatedAt").textContent = conversationActivityLabel(selected);
  setOriginalChatLink($("sourceLink"), selected.canonical_chat_url);
  $("conversationSummaryStatus").textContent = "";
  if (!summaries) await loadSummaries();
  renderConversationSummary(selected);
  const coverage = selected.transcriptCoverage;
  const coverageNotice = $("transcriptCoverageNotice");
  const coverageReasons = coverage?.reasons || [];
  coverageNotice.classList.toggle("hidden", !coverageReasons.length);
  coverageNotice.textContent = coverageReasons.length
    ? `Capture reported that this transcript may be incomplete. ${coverageReasons.join(" ")}`
    : "";
  $("transcriptSort").value = "latest";
  renderTranscriptMessages(options.sourceEventId ?? null);
  $("detailDialog").showModal();
  if (options.sourceEventId != null) {
    const target = [...$("messages").children].find((message) => message.dataset.eventId === String(options.sourceEventId));
    if (target) {
      target.classList.add("message-source-target");
      requestAnimationFrame(() => target.scrollIntoView({ block: "center", behavior: "smooth" }));
    }
  }
}
$("authForm").onsubmit=async(e)=>{e.preventDefault();$("authError").textContent="";try{session=await supabase("/auth/v1/token?grant_type=password",{method:"POST",body:JSON.stringify({email:$("email").value,password:$("password").value})});localStorage.setItem("memory_session",JSON.stringify(session));await boot();}catch{$("authError").textContent="The email or password was not accepted.";}};
$("signOut").onclick=()=>{localStorage.removeItem("memory_session");session=null;showAuth();};
$("dashboardNav").onclick=()=>showView("dashboard");
$("memoryNav").onclick=()=>showView("memory");
$("summariesNav").onclick=()=>showView("summaries");
$("connectedNav").onclick=()=>showView("connected");
$("diagnosticsNav").onclick=()=>showView("diagnostics");
$("settingsNav").onclick=()=>showView("settings");
$("mapFullscreenButton").onclick=toggleMapFullscreen;
$("mapZoomIn").onclick=()=>zoomMemoryGraph(1.3);
$("mapZoomOut").onclick=()=>zoomMemoryGraph(1 / 1.3);
$("mapFit").onclick=()=>{ if (memoryGraph?.nodes().length) { memoryGraph.fit(memoryGraph.nodes(), 70); $("mapSelection").textContent = "Overview of all chats. Zoom in or use Find to focus on a chat and its neighbors."; } };
$("mapSearchButton").onclick=findConversationOnMap;
$("mapSearch").addEventListener("keydown",(event)=>{ if(event.key === "Enter") { event.preventDefault(); findConversationOnMap(); } });
$("addProviderButton").onclick=()=>$("providerDialog").showModal();
$("closeProviderDialog").onclick=()=>$("providerDialog").close();
document.querySelectorAll(".settings-nav a").forEach((link)=>link.onclick=(event)=>{
  event.preventDefault();
  const section=document.querySelector(link.getAttribute("href"));
  document.querySelectorAll(".settings-nav a").forEach((item)=>{item.classList.remove("active");item.removeAttribute("aria-current");});
  link.classList.add("active");
  link.setAttribute("aria-current","location");
  section?.scrollIntoView({behavior:"smooth",block:"start"});
  history.replaceState(null,"",link.getAttribute("href"));
  setTimeout(updateSettingsNavActive,220);
});
window.addEventListener("scroll", updateSettingsNavActive, { passive: true });
document.addEventListener("fullscreenchange", updateMapFullscreenState);
document.addEventListener("keydown",(event)=>{ if(event.key === "Escape" && $("connectionMap").classList.contains("map-fullscreen-fallback")) toggleMapFullscreen(); });
$("sidebarToggle").onclick=()=>setSidebarCollapsed(!$("shell").classList.contains("sidebar-collapsed"));
$("openDiagnostics").onclick=()=>showView("diagnostics");
$("refreshDiagnostics").onclick=()=>loadDiagnostics();
$("dashboardRefresh").onclick=async()=>{ await boot(); };
document.querySelectorAll("[data-dashboard-metric]").forEach((card) => card.onclick=()=>openMetricDialog(card.dataset.dashboardMetric));
$("reviewFocusButton").onclick=()=>{ reviewMode="focus"; $("reviewFocusButton").classList.add("active-segment"); $("reviewAllButton").classList.remove("active-segment"); if(memoryData) { renderMemory(); requestAnimationFrame(() => { const card = document.querySelector("#reviewView .review-section:not(.hidden) .conflict-card, #reviewView .review-section:not(.hidden) .claim-card"); card?.scrollIntoView({ behavior: "smooth", block: "center" }); card?.focus({ preventScroll: true }); }); } };
$("reviewAllButton").onclick=()=>{ reviewMode="all"; $("reviewAllButton").classList.add("active-segment"); $("reviewFocusButton").classList.remove("active-segment"); if(memoryData) renderMemory(); };
$("conflictSearch").oninput=()=>{ conflictFilters.query=$("conflictSearch").value.trim(); conflictFilters.page=1; if(memoryData) renderMemory(); };
$("conflictSort").onchange=()=>{ conflictFilters.sort=$("conflictSort").value; conflictFilters.page=1; if(memoryData) renderMemory(); };
$("conflictPrevious").onclick=()=>{ conflictFilters.page=Math.max(1, conflictFilters.page-1); renderMemory(); $("conflictSection").scrollIntoView({ behavior:"smooth", block:"start" }); };
$("conflictNext").onclick=()=>{ conflictFilters.page+=1; renderMemory(); $("conflictSection").scrollIntoView({ behavior:"smooth", block:"start" }); };
$("conversationSearch").oninput=updateConversationFilters;
$("chatSort").onchange=()=>{ chatSort=$("chatSort").value; localStorage.setItem("sherry_chat_sort", chatSort); render(); };
$("chatGridView").onclick=()=>{ chatView="grid"; localStorage.setItem("sherry_chat_view", chatView); render(); };
$("chatTableView").onclick=()=>{ chatView="table"; localStorage.setItem("sherry_chat_view", chatView); render(); };
$("refreshChatMemory").onclick=refreshChatMemory;
$("selectChats").onclick=()=>{ selectingChats=!selectingChats; if(!selectingChats) selectedChatIds.clear(); $("chatBulkStatus").textContent=""; render(); };
$("selectVisibleChats").onclick=()=>{ for(const chat of filteredConversations()) selectedChatIds.add(chat.id); render(); };
$("clearSelectedChats").onclick=()=>{ selectedChatIds.clear(); render(); };
$("deleteSelectedChats").onclick=()=>openBulkDeleteDialog([...selectedChatIds], false);
$("settingsDeleteChats").onclick=async()=>{
  if(isPreview || deletingChats || !workspace?.id) return;
  $("settingsDeleteChats").disabled=true;
  $("settingsDeleteChatsStatus").textContent="Checking stored chats…";
  try {
    const result=await api(`/v1/conversations?workspaceId=${workspace.id}`, {cache:"no-store"});
    if(!Array.isArray(result.conversations)) throw new Error("The chat list was not returned.");
    conversations=result.conversations;
    render();
    if(!conversations.length){ $("settingsDeleteChatsStatus").textContent="There are no chats to delete."; return; }
    $("settingsDeleteChatsStatus").textContent="";
    openBulkDeleteDialog(conversations.map((chat)=>chat.id), true);
  }catch(error){ $("settingsDeleteChatsStatus").textContent=`Could not check chats: ${error.message}`; }
  finally{ render(); }
};
$("cancelBulkDelete").onclick=()=>{ bulkDeleteTarget=null; $("bulkDeleteDialog").close(); };
$("bulkDeleteConfirmation").oninput=()=>{ $("confirmBulkDelete").disabled=$("bulkDeleteConfirmation").value!=="DELETE ALL CHATS"; };
$("confirmBulkDelete").onclick=deleteChatBatch;
["providerFilter","deviceFilter","dateFilter","artifactFilter"].forEach((id)=>$(id).onchange=updateConversationFilters);
$("dateFrom").onchange=updateConversationFilters;
$("dateTo").onchange=updateConversationFilters;
$("clearCustomDates").onclick=()=>{ $("dateFrom").value=""; $("dateTo").value=""; $("dateFilter").value="all"; updateConversationFilters(); };
$("providerFilterButton").onclick=(event)=>{ event.stopPropagation(); const expanded=$("providerFilterButton").getAttribute("aria-expanded") === "true"; $("providerFilterMenu").classList.toggle("hidden", expanded); $("providerFilterButton").setAttribute("aria-expanded", String(!expanded)); };
document.querySelectorAll("#providerFilterMenu .select-option[data-value]").forEach((option)=>option.onclick=()=>selectProviderFilter(option.dataset.value, option.querySelector("span").textContent));
document.addEventListener("click",(event)=>{ if(!event.target.closest(".custom-select")) closeProviderMenu(); });
document.addEventListener("keydown",(event)=>{ if(event.key === "Escape") closeProviderMenu(); });
$("addMemoryButton").onclick=()=>{ renderMemoryCategoryOptions(); $("memoryDialog").showModal(); };
$("addCategoryButton").onclick=()=>$("categoryDialog").showModal();
$("cancelMemory").onclick=()=>$("memoryDialog").close();
$("memoryForm").onsubmit=addPersonalMemory;
$("cancelCategory").onclick=()=>$("categoryDialog").close();
$("categoryForm").onsubmit=addPersonalMemoryCategory;
$("summarizerForm").onsubmit=(event)=>{event.preventDefault();saveSettings(false);};
$("runSummaryNow").onclick=runSummaryNow;
$("removeApiKey").onclick=()=>{if(confirm("Remove the saved summarization API key? Automatic summaries will pause until a new key is saved.")) saveSettings(true);};
$("retrievalTestForm").onsubmit=testRetrieval;
[
  ["sensitivityFinancial", "financial_enabled"],
  ["sensitivityHealth", "health_enabled"],
  ["sensitivityPersonal", "personal_enabled"]
].forEach(([id]) => $(id).onchange=saveSensitivitySettings);
$("copyMcpEndpoint").onclick=async()=>{await navigator.clipboard.writeText($("mcpEndpoint").value);$("copyMcpEndpoint").textContent="Copied";setTimeout(()=>$("copyMcpEndpoint").textContent="Copy address",1500);};
["extensionCaptureEnabled", "extensionCaptureAttachments", "extensionCaptureTemporary", "extensionDebugMode"].forEach((id)=>$(id).onchange=saveExtensionControls);
$("extensionRefresh").onclick=loadExtensionStatus;
$("extensionRetry").onclick=()=>runExtensionAction("RETRY_UPLOADS", "Retrying pending uploads…");
$("extensionReupload").onclick=()=>runExtensionAction("REUPLOAD_EXISTING", "Queueing existing captures…");
$("closeMetricDialog").onclick=()=>$("metricDialog").close();
$("closeDialog").onclick=()=>$("detailDialog").close();
$("transcriptSort").onchange=()=>renderTranscriptMessages();
$("summarizeConversation").onclick=summarizeSelectedConversation;
$("closeSummary").onclick=()=>$("summaryDialog").close();
["detailDialog", "metricDialog", "summaryDialog"].forEach((id)=>{
  $(id).addEventListener("pointerdown", rememberDialogBackdropPointer);
  $(id).addEventListener("click", closeDialogFromBackdrop);
});
$("saveSummary").onclick=saveSummaryEdit;
$("deleteSummary").onclick=removeSummary;
$("exportOne").onclick=()=>download(`${selected.title.replace(/[^a-z0-9]+/gi,"-").toLowerCase()}.json`,selected);
$("deleteOne").onclick=()=>{$("deleteStatus").textContent="";$("deleteDialog").showModal();};$("cancelDelete").onclick=()=>$("deleteDialog").close();
$("confirmDelete").onclick=async()=>{
  const id=selected.id;
  $("confirmDelete").disabled=true;
  let result;
  try {
    result=isPreview?null:await api(`/v1/conversations/${id}?workspaceId=${workspace.id}`,{method:"DELETE"});
  } catch(error) {
    $("deleteStatus").textContent=error.message||"Deletion could not be completed. Please try again.";
    $("confirmDelete").disabled=false;
    return;
  }
  conversations=conversations.filter(c=>c.id!==id);
  dashboardData=isPreview?previewDashboardMetrics():await api(`/v1/dashboard?workspaceId=${workspace.id}`).catch(()=>dashboardFallbackFromConversations(conversations));
  $("deleteDialog").close();
  $("detailDialog").close();
  render();
  prepareExport();
  if(result?.deleted?.cleanupPending){
    bootDataAlerts.push({severity:"warning",title:"Chat deleted; archive cleanup pending",message:"The chat is no longer available in Sherry. A background retry is finishing raw archive cleanup.",action:"Check Diagnostics again in a few minutes."});
    renderSystemAlerts({alerts:[]});
  }
  $("confirmDelete").disabled=false;
};
$("settingsExport").onclick=(event)=>{event.preventDefault(); if(exportPayload) download("memory-export.json", exportPayload);};
$("historyImportForm").onsubmit=importProviderHistory;
$("historyImportProvider").onchange=updateHistoryImportProvider;
$("historyImportFile").onchange=()=>{ pendingClaudeImport=null; $("historyImportButton").textContent=$("historyImportProvider").value==="claude"?"Preview Claude import":"Import chats"; $("historyImportButton").disabled=false; $("historyImportStatus").textContent=""; };
updateHistoryImportProvider();
document.addEventListener("sherry-capture-ready", () => {
  if ($("diagnosticsView")?.classList.contains("hidden")) return;
  void loadExtensionStatus();
  void connectExtensionWorkspace();
});
setSidebarCollapsed(localStorage.getItem("sherry_sidebar_collapsed") === "true");
renderPersonalMemoryCategories();
boot();
setInterval(() => { if (workspace && session?.access_token) loadDiagnostics(); }, 60_000);
