const SUPABASE_URL = "https://zwpzmmfpgjaaikacoqas.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_mEtfpCKWHYDKARfWNNO5BA_ouWQWmfN";
const WORKER_URL = "https://shared-memory-ingestion.mufaddal-m25.workers.dev";
const extensionApi = globalThis.browser ?? globalThis.chrome;

const nodes = {
  totalEvents: document.querySelector("#total-events"),
  updatedEvents: document.querySelector("#updated-events"),
  duplicateEvents: document.querySelector("#duplicate-events"),
  diagnosticCount: document.querySelector("#diagnostic-count"),
  lastCapture: document.querySelector("#last-capture"),
  diagnosticRows: document.querySelector("#diagnostic-rows"),
  capturedEvents: document.querySelector("#captured-events"),
  syncNotice: document.querySelector("#sync-notice"),
  syncStatus: document.querySelector("#sync-status"),
  authForm: document.querySelector("#auth-form"),
  authEmail: document.querySelector("#auth-email"),
  authPassword: document.querySelector("#auth-password"),
  authMessage: document.querySelector("#auth-message"),
  createAccount: document.querySelector("#create-account"),
  syncForm: document.querySelector("#sync-form"),
  syncEndpoint: document.querySelector("#sync-endpoint"),
  syncWorkspace: document.querySelector("#sync-workspace"),
  syncToken: document.querySelector("#sync-token"),
  syncBackfill: document.querySelector("#sync-backfill"),
  syncMessage: document.querySelector("#sync-message"),
  retrySync: document.querySelector("#retry-sync"),
  reuploadExisting: document.querySelector("#reupload-existing"),
  disconnectSync: document.querySelector("#disconnect-sync"),
  refresh: document.querySelector("#refresh"),
  export: document.querySelector("#export")
};

let currentData = null;

function runtimeMessage(message) {
  if (globalThis.browser) return extensionApi.runtime.sendMessage(message);
  return new Promise((resolve) => extensionApi.runtime.sendMessage(message, resolve));
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderDiagnostics(events) {
  nodes.diagnosticRows.replaceChildren();
  if (!events.length) {
    const row = document.createElement("tr");
    const empty = cell("No diagnostic events yet. Open a supported AI conversation and refresh this page.");
    empty.colSpan = 4;
    empty.className = "empty";
    row.append(empty);
    nodes.diagnosticRows.append(row);
    return;
  }

  [...events].reverse().slice(0, 150).forEach((event) => {
    const row = document.createElement("tr");
    row.append(
      cell(formatDate(event.at)),
      cell(`${event.provider || "unknown"} · ${event.stage || "unknown"}`),
      cell(event.status || "unknown", `status ${event.status || ""}`)
    );
    const details = document.createElement("td");
    const code = document.createElement("code");
    code.textContent = JSON.stringify(event.detail ?? {}, null, 2);
    details.append(code);
    row.append(details);
    nodes.diagnosticRows.append(row);
  });
}

function renderCapturedEvents(events) {
  nodes.capturedEvents.replaceChildren();
  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No messages captured yet.";
    nodes.capturedEvents.append(empty);
    return;
  }

  [...events].reverse().slice(0, 100).forEach((event) => {
    const article = document.createElement("article");
    article.className = "event";
    const meta = document.createElement("div");
    meta.className = "event-meta";
    const role = document.createElement("span");
    role.className = "event-role";
    role.textContent = event.role;
    const conversation = document.createElement("span");
    conversation.textContent = event.conversationId;
    const capturedAt = document.createElement("span");
    capturedAt.textContent = formatDate(event.capturedAt);
    const hash = document.createElement("span");
    hash.textContent = `hash ${event.contentHash}`;
    const providerMessage = document.createElement("span");
    providerMessage.textContent = event.providerMessageId ? `source ${event.providerMessageId}` : "source fallback";
    const provider = document.createElement("span");
    provider.textContent = event.provider || "unknown";
    meta.append(provider, role, conversation, capturedAt, providerMessage, hash);
    const text = document.createElement("div");
    text.className = "event-text";
    text.textContent = event.text;
    article.append(meta, text);
    nodes.capturedEvents.append(article);
  });
}

function renderSync(ingestion = {}) {
  const connected = ingestion.enabled && ingestion.hasAccessToken;
  const quarantined = Number(ingestion.quarantinedBatches || 0);
  nodes.syncEndpoint.value = ingestion.endpoint || "";
  nodes.syncWorkspace.value = ingestion.workspaceId || "";
  nodes.syncToken.value = "";
  nodes.syncStatus.textContent = ingestion.blockedReason || quarantined
    ? "Needs attention"
    : connected
      ? `${ingestion.pendingBatches || 0} pending`
      : "Not connected";
  nodes.syncStatus.className = `pill${ingestion.blockedReason || quarantined ? " pill-error" : ""}`;
  nodes.syncNotice.textContent = ingestion.blockedReason
    ? `Cloud sync paused: ${ingestion.blockedReason}`
    : quarantined
      ? `Cloud sync is continuing, but ${quarantined} invalid batch${quarantined === 1 ? " was" : "es were"} quarantined. ${ingestion.latestQuarantine?.message || "Open Pipeline activity for the exact validation details."}`
    : connected
      ? `Cloud sync is connected. ${ingestion.pendingBatches || 0} batch${ingestion.pendingBatches === 1 ? "" : "es"} pending.`
      : "Cloud sync is not configured. Captured events remain in extension-local storage.";
  nodes.retrySync.disabled = !connected || !(ingestion.pendingBatches > 0);
  nodes.disconnectSync.disabled = !connected;
}

async function refresh() {
  currentData = await runtimeMessage({ type: "GET_STATUS" });
  const stats = currentData?.captureStats ?? {};
  const events = currentData?.capturedEvents ?? [];
  const diagnostics = currentData?.diagnosticEvents ?? [];
  nodes.totalEvents.textContent = String(stats.totalEvents ?? events.length);
  nodes.updatedEvents.textContent = String(stats.updatedEvents ?? 0);
  nodes.duplicateEvents.textContent = String(stats.duplicateEvents ?? 0);
  nodes.diagnosticCount.textContent = String(stats.diagnosticEvents ?? diagnostics.length);
  nodes.lastCapture.textContent = stats.lastCaptureAt ? `Last capture ${formatDate(stats.lastCaptureAt)}` : "No captures yet";
  renderDiagnostics(diagnostics);
  renderCapturedEvents(events);
  renderSync(currentData?.ingestion);
}

function requestConnectionPermissions(endpoints) {
  const origins = [...new Set(endpoints.map((endpoint) => `${new URL(endpoint).origin}/*`))];
  return extensionApi.permissions.request({ origins });
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.msg || body.message || body.error_description || body.error || "Supabase rejected the request.");
  return body;
}

async function getOrCreateWorkspace(session) {
  const headers = { authorization: `Bearer ${session.access_token}` };
  const existing = await supabaseRequest("/rest/v1/workspaces?select=id,name&order=created_at.asc&limit=1", { headers });
  if (existing[0]) return existing[0];
  const created = await supabaseRequest("/rest/v1/workspaces?select=id,name", {
    method: "POST",
    headers: { ...headers, prefer: "return=representation" },
    body: JSON.stringify({ owner_user_id: session.user.id, name: "My Memory" })
  });
  if (!created[0]) throw new Error("The private workspace could not be created.");
  return created[0];
}

async function connectSession(session) {
  const workspace = await getOrCreateWorkspace(session);
  const result = await runtimeMessage({
    type: "UPDATE_INGESTION_CONFIG",
    payload: {
      endpoint: WORKER_URL,
      workspaceId: workspace.id,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at,
      uploadExisting: true
    }
  });
  if (!result?.ok) throw new Error(result?.error || "The cloud connection could not be saved.");
  nodes.authPassword.value = "";
  nodes.authMessage.textContent = `Connected to ${workspace.name}. Existing captures are queued for upload.`;
  await refresh();
}

async function createTestAccount() {
  nodes.authMessage.textContent = "Creating the test account…";
  const session = await supabaseRequest("/auth/v1/signup", {
    method: "POST",
    body: JSON.stringify({ email: nodes.authEmail.value.trim(), password: nodes.authPassword.value })
  });
  if (!session.access_token) {
    nodes.authPassword.value = "";
    nodes.authMessage.textContent = "Account created. Confirm the email from Supabase, then return here and select Sign in and connect.";
    return;
  }
  await connectSession(session);
}

nodes.authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  nodes.authMessage.textContent = "Signing in and creating your private workspace…";
  requestConnectionPermissions([SUPABASE_URL, WORKER_URL])
    .then(async (permission) => {
      if (!permission) throw new Error("Browser permission for the Memory cloud services was not granted.");
      const session = await supabaseRequest("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: JSON.stringify({ email: nodes.authEmail.value.trim(), password: nodes.authPassword.value })
      });
      await connectSession(session);
    })
    .catch((error) => {
      nodes.authPassword.value = "";
      nodes.authMessage.textContent = error.message;
    });
});

nodes.createAccount.addEventListener("click", () => {
  if (!nodes.authForm.reportValidity()) return;
  requestConnectionPermissions([SUPABASE_URL, WORKER_URL])
    .then(async (permission) => {
      if (!permission) throw new Error("Browser permission for the Memory cloud services was not granted.");
      await createTestAccount();
    })
    .catch((error) => {
      nodes.authPassword.value = "";
      nodes.authMessage.textContent = error.message;
    });
});

nodes.syncForm.addEventListener("submit", (event) => {
  event.preventDefault();
  nodes.syncMessage.textContent = "Checking permission…";
  requestConnectionPermissions([nodes.syncEndpoint.value])
    .then(async (permission) => {
      if (!permission) throw new Error("Browser permission for this Worker URL was not granted.");
      const result = await runtimeMessage({
        type: "UPDATE_INGESTION_CONFIG",
        payload: {
          endpoint: nodes.syncEndpoint.value,
          workspaceId: nodes.syncWorkspace.value.trim(),
          accessToken: nodes.syncToken.value.trim(),
          uploadExisting: nodes.syncBackfill.checked
        }
      });
      if (!result?.ok) throw new Error(result?.error || "The cloud connection could not be saved.");
      nodes.syncMessage.textContent = nodes.syncBackfill.checked
        ? "Connected. Existing captures are being uploaded again with a new batch identity."
        : "Connected. Pending batches will upload in the background.";
      await refresh();
    })
    .catch((error) => {
      nodes.syncMessage.textContent = error.message;
    });
});

nodes.retrySync.addEventListener("click", async () => {
  nodes.syncMessage.textContent = "Retrying pending batches…";
  await runtimeMessage({ type: "RETRY_UPLOADS" });
  setTimeout(refresh, 750);
});

nodes.reuploadExisting.addEventListener("click", async () => {
  nodes.syncMessage.textContent = "Re-uploading existing captures…";
  const result = await runtimeMessage({ type: "REUPLOAD_EXISTING" });
  nodes.syncMessage.textContent = result?.ok
    ? "Existing captures were queued with a new batch identity."
    : result?.error || "The repair backfill could not be queued.";
  setTimeout(refresh, 750);
});

nodes.disconnectSync.addEventListener("click", async () => {
  await runtimeMessage({ type: "CLEAR_INGESTION_CONFIG" });
  nodes.syncMessage.textContent = "Disconnected. The local capture history remains available.";
  await refresh();
});

nodes.refresh.addEventListener("click", refresh);
nodes.export.addEventListener("click", async () => {
  if (!currentData) await refresh();
  const payload = JSON.stringify({
    exportedAt: new Date().toISOString(),
    captureStats: currentData.captureStats,
    capturedEvents: currentData.capturedEvents,
    diagnosticEvents: currentData.diagnosticEvents
  }, null, 2);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  link.download = `shared-memory-diagnostics-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

refresh();
