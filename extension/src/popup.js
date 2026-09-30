const captureEnabled = document.querySelector("#capture-enabled");
const captureNow = document.querySelector("#capture-now");
const openDiagnostics = document.querySelector("#open-diagnostics");
const connectSherry = document.querySelector("#connect-sherry");
const pageStatus = document.querySelector("#page-status");
const eventCount = document.querySelector("#event-count");
const lastCapture = document.querySelector("#last-capture");
const syncStatus = document.querySelector("#sync-status");
const errorNode = document.querySelector("#error");
const syncAlert = document.querySelector("#sync-alert");
const scanStatus = document.querySelector("#scan-status");
const extensionApi = globalThis.browser ?? globalThis.chrome;
const SHERRY_DIAGNOSTICS_URL = "https://shared-memory-ingestion.mufaddal-m25.workers.dev/#diagnostics";
const SHERRY_ORIGIN_PATTERN = "https://shared-memory-ingestion.mufaddal-m25.workers.dev/*";
document.querySelector("#extension-version").textContent = `SHERRY CAPTURE · v${extensionApi.runtime.getManifest().version}`;
let sherryTabId = null;
connectSherry.disabled = true;

function requestSherryHostPermission() {
  // Chromium already grants this required host permission at installation.
  // Calling permissions.request for a non-optional origin can fail there.
  if (!globalThis.browser) return Promise.resolve(true);
  const request = { origins: [SHERRY_ORIGIN_PATTERN] };
  return extensionApi.permissions.request(request);
}

async function reconnectSherryTab(tab) {
  if (!tab?.url?.startsWith("https://shared-memory-ingestion.mufaddal-m25.workers.dev/")) {
    throw new Error("Open the Sherry Diagnostics page first, then use Reconnect Sherry page.");
  }
  await extensionApi.scripting.executeScript({ target: { tabId: tab.id }, files: ["/src/sherry-bridge.js"] });
}

function runtimeMessage(message) {
  if (globalThis.browser) return extensionApi.runtime.sendMessage(message);
  return new Promise((resolve) => extensionApi.runtime.sendMessage(message, resolve));
}

async function activeTab() {
  const [tab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function tabMessage(tabId, message) {
  if (globalThis.browser) {
    return extensionApi.tabs.sendMessage(tabId, message)
      .catch((error) => ({ ok: false, error: error.message }));
  }
  return new Promise((resolve) => {
    extensionApi.tabs.sendMessage(tabId, message, (response) => {
      if (extensionApi.runtime.lastError) {
        resolve({ ok: false, error: extensionApi.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

function providerAdapterFiles(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (host === "chatgpt.com" || host === "chat.openai.com") {
    return ["/src/core.js", "/src/chatgpt-adapter.js"];
  }
  if (host === "claude.ai" || host === "gemini.google.com") {
    return [
      "/src/core.js",
      "/src/web-provider-adapter.js",
      host === "claude.ai" ? "/src/claude-adapter.js" : "/src/gemini-adapter.js"
    ];
  }
  return null;
}

function missingReceiver(response) {
  return !response?.ok && /receiving end does not exist|no matching message handler|could not establish connection/i.test(response?.error || "");
}

async function ensureCaptureAdapter(tab) {
  let response = await tabMessage(tab.id, { type: "GET_CAPTURE_STATE" });
  if (!missingReceiver(response)) return response;

  const files = providerAdapterFiles(tab.url);
  if (!files) return response;
  try {
    // Content scripts are not inserted into tabs that were already open when an
    // add-on was loaded or updated. The popup's activeTab grant lets us recover.
    const results = await extensionApi.scripting.executeScript({ target: { tabId: tab.id }, files });
    const scriptError = results?.find((result) => result.error)?.error;
    if (scriptError) throw new Error(scriptError.message || String(scriptError));
  } catch (error) {
    return { ok: false, error: `Sherry Capture could not access this tab: ${error.message}. Check site access in Zen's add-on settings, then reopen this conversation.` };
  }
  response = await tabMessage(tab.id, { type: "GET_CAPTURE_STATE" });
  return missingReceiver(response)
    ? { ok: false, error: "The capture script was inserted but did not start. Reload this conversation tab and open Sherry Capture again." }
    : response;
}

function showError(message) {
  errorNode.hidden = !message;
  errorNode.textContent = message || "";
}

function formatTime(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

async function refresh() {
  const status = await runtimeMessage({ type: "GET_STATUS" });
  captureEnabled.checked = status?.settings?.captureEnabled ?? true;
  eventCount.textContent = String(status?.captureStats?.totalEvents ?? 0);
  lastCapture.textContent = formatTime(status?.captureStats?.lastCaptureAt);
  const ingestion = status?.ingestion || {};
  syncStatus.textContent = !ingestion.enabled || !ingestion.hasAccessToken
    ? "Cloud sync is disconnected. Local captures will not appear in Sherry."
    : ingestion.pendingBatches
      ? `${ingestion.pendingBatches} upload batch${ingestion.pendingBatches === 1 ? "" : "es"} pending · last sync ${formatTime(ingestion.lastSyncAt)}`
      : ingestion.lastSyncAt
        ? `Cloud synced ${formatTime(ingestion.lastSyncAt)} · no uploads pending`
        : "Cloud connected · no upload confirmed yet";
  const syncProblem = ingestion.blockedReason
    || ingestion.lastSyncError
    || (ingestion.quarantinedBatches
      ? `${ingestion.quarantinedBatches} invalid cloud batch${ingestion.quarantinedBatches === 1 ? " needs" : "es need"} review. Later captures are still syncing.`
      : null);
  syncAlert.hidden = !syncProblem;
  syncAlert.textContent = syncProblem ? `Cloud memory: ${syncProblem}` : "";

  const tab = await activeTab();
  sherryTabId = tab?.url?.startsWith("https://shared-memory-ingestion.mufaddal-m25.workers.dev/") ? tab.id : null;
  connectSherry.disabled = !sherryTabId;
  const providerMatch = (tab?.url ?? "").match(/^https:\/\/(?:chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com)\//i);
  captureNow.disabled = !providerMatch;
  if (!providerMatch) {
    pageStatus.textContent = "Open a ChatGPT, Claude, or Gemini conversation to test capture.";
    scanStatus.textContent = "No supported chat page is open.";
    return;
  }

  const page = await ensureCaptureAdapter(tab);
  if (!page?.ok) {
    pageStatus.textContent = "Capture is not connected to this conversation.";
    scanStatus.textContent = "No page scan is available.";
    showError(page?.error || "The capture adapter is unavailable on this tab.");
    return;
  }

  pageStatus.textContent = page.conversationId
    ? `Ready · ${page.provider} · ${page.conversationId}`
    : "Ready · waiting for a conversation";
  scanStatus.textContent = page.lastScanCandidates == null
    ? "This page has not reported a scan yet."
    : `Last page scan: ${page.lastScanCandidates} visible turns · ${page.lastScanStored ?? page.lastScanEmitted ?? 0} stored changes`;
  showError(page.lastError);
}

captureEnabled.addEventListener("change", async () => {
  await runtimeMessage({ type: "UPDATE_SETTINGS", payload: { captureEnabled: captureEnabled.checked } });
  await refresh();
});

captureNow.addEventListener("click", async () => {
  const tab = await activeTab();
  captureNow.disabled = true;
  const adapter = await ensureCaptureAdapter(tab);
  const response = adapter?.ok
    ? await tabMessage(tab.id, { type: "CAPTURE_NOW" })
    : adapter;
  showError(response?.ok ? null : response?.error || "Manual capture failed.");
  if (response?.candidates != null) scanStatus.textContent = `Manual scan: ${response.candidates} visible turns · ${response.stored ?? response.emitted ?? 0} stored changes`;
  else if (response?.ok) scanStatus.textContent = "Manual scan completed. Reload this chat if its messages are not visible.";
  setTimeout(refresh, 250);
});

openDiagnostics.addEventListener("click", () => extensionApi.tabs.create({ url: SHERRY_DIAGNOSTICS_URL }));

connectSherry.addEventListener("click", () => {
  if (!sherryTabId) {
    showError("Open the Sherry Diagnostics page first, then use Reconnect Sherry page.");
    return;
  }
  // Firefox requires permissions.request in the original click stack, before any await.
  let permission;
  try { permission = requestSherryHostPermission(); }
  catch (error) { showError(error.message); return; }
  connectSherry.disabled = true;
  showError(null);
  void (async () => {
    if (!await permission) throw new Error("Allow Sherry Capture access to the Sherry site to connect Diagnostics.");
    const tab = await activeTab();
    if (tab?.id !== sherryTabId) throw new Error("The active tab changed. Open Sherry Diagnostics and try again.");
    await reconnectSherryTab(tab);
    pageStatus.textContent = "Sherry page bridge connected. Return to Diagnostics to see live extension status.";
  })().catch((error) => showError(error.message)).finally(() => { connectSherry.disabled = false; });
});

refresh().catch((error) => showError(error.message));
