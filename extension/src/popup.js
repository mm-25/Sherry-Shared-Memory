const captureEnabled = document.querySelector("#capture-enabled");
const captureNow = document.querySelector("#capture-now");
const repairChat = document.querySelector("#repair-chat");
const repairStatus = document.querySelector("#repair-status");
const repairCount = document.querySelector("#repair-count");
const repairExplainer = document.querySelector("#repair-explainer");
const attentionPanel = document.querySelector("#attention-panel");
const captureSettingDescription = document.querySelector("#capture-setting-description");
const coverageNote = document.querySelector("#coverage-note");
const openDiagnostics = document.querySelector("#open-diagnostics");
const connectSherry = document.querySelector("#connect-sherry");
const pageStatus = document.querySelector("#page-status");
const eventCount = document.querySelector("#event-count");
const lastCapture = document.querySelector("#last-capture");
const syncStatus = document.querySelector("#sync-status");
const errorNode = document.querySelector("#error");
const syncAlert = document.querySelector("#sync-alert");
const scanStatus = document.querySelector("#scan-status");
const siteAccessPanel = document.querySelector("#site-access-panel");
const siteAccessDescription = document.querySelector("#site-access-description");
const grantSiteAccess = document.querySelector("#grant-site-access");
const saveCaptureReport = document.querySelector("#save-capture-report");
const reportDescription = document.querySelector("#report-description");
const extensionApi = globalThis.browser ?? globalThis.chrome;
const SHERRY_DIAGNOSTICS_URL = "https://shared-memory-ingestion.mufaddal-m25.workers.dev/#diagnostics";
const SHERRY_ORIGIN_PATTERN = "https://shared-memory-ingestion.mufaddal-m25.workers.dev/*";
document.querySelector("#extension-version").textContent = `Capture · v${extensionApi.runtime.getManifest().version}`;
let sherryTabId = null;
let activeCapture = null;
let captureTab = null;
let captureSiteOrigin = null;
let captureSiteAccess = null;
let confirmedCaptureEnabled = null;
let captureSettingSavePending = false;
captureEnabled.disabled = true;
connectSherry.disabled = true;
repairChat.disabled = true;

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
  const accepted = (response) => {
    if (!response) throw new Error("The capture background did not respond.");
    if (response.ok === false) throw new Error(response.error || "The extension did not accept the request.");
    return response;
  };
  if (globalThis.browser) return extensionApi.runtime.sendMessage(message).then(accepted);
  return new Promise((resolve, reject) => extensionApi.runtime.sendMessage(message, (response) => {
    const error = extensionApi.runtime.lastError;
    if (error) { reject(new Error(error.message)); return; }
    try { resolve(accepted(response)); } catch (failure) { reject(failure); }
  }));
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

async function persistentSiteAccess(origin) {
  try {
    // getAll excludes the temporary activeTab grant obtained by opening a popup.
    const permissions = await extensionApi.permissions.getAll();
    const host = new URL(origin).hostname;
    const granted = (permissions.origins || []).some((pattern) => {
      if (pattern === "<all_urls>") return true;
      const match = pattern.match(/^(https|\*):\/\/([^/]+)\/\*$/);
      if (!match) return false;
      return match[2] === "*" || match[2] === host
        || (match[2].startsWith("*.") && (host === match[2].slice(2) || host.endsWith(`.${match[2].slice(2)}`)));
    });
    return granted;
  } catch {
    return null;
  }
}

function showError(message) {
  errorNode.hidden = !message;
  errorNode.textContent = message || "";
}

function formatTime(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function scanSummary(page) {
  if (page.lastScanCandidates == null) return "Waiting for the first page scan.";
  const seen = page.lastScanCandidates;
  const readable = Number.isInteger(page.lastScanReadable) ? page.lastScanReadable : null;
  const changed = page.lastScanStored ?? page.lastScanEmitted ?? 0;
  const first = readable == null
    ? `${seen} message areas found on this page.`
    : `${seen} message areas found · ${readable} readable messages.`;
  return `${first} ${changed ? `${changed} new local change${changed === 1 ? "" : "s"} in the last scan.` : "No new local changes in the last scan."}`;
}

async function refresh() {
  const status = await runtimeMessage({ type: "GET_STATUS" });
  confirmedCaptureEnabled = status?.settings?.captureEnabled ?? true;
  captureEnabled.checked = confirmedCaptureEnabled;
  captureEnabled.disabled = captureSettingSavePending;
  captureSettingDescription.textContent = captureEnabled.checked
    ? "On for supported ChatGPT, Claude, and Gemini chats"
    : "Paused. New messages will not be saved.";
  eventCount.textContent = String(status?.captureStats?.totalEvents ?? 0);
  lastCapture.textContent = formatTime(status?.captureStats?.lastCaptureAt);
  const ingestion = status?.ingestion || {};
  const cloudConnected = Boolean(ingestion.enabled && ingestion.hasAccessToken);
  syncStatus.textContent = !cloudConnected
    ? "Cloud upload is disconnected. Saved work stays on this device."
    : ingestion.pendingBatches
      ? `${ingestion.pendingBatches} upload batch${ingestion.pendingBatches === 1 ? "" : "es"} waiting · last successful upload ${formatTime(ingestion.lastSyncAt)}`
      : ingestion.lastSyncAt
        ? `No uploads waiting · last successful upload ${formatTime(ingestion.lastSyncAt)}`
        : "Cloud connected · no successful upload yet";
  const syncProblem = (!cloudConnected
    ? "Connect Sherry in diagnostics before expecting new captures to appear in your cloud memory."
    : null)
    || ingestion.blockedReason
    || ingestion.lastSyncError
    || (ingestion.quarantinedBatches
      ? `${ingestion.quarantinedBatches} earlier upload${ingestion.quarantinedBatches === 1 ? " failed" : "s failed"}. They may include other chats. Newer messages can still upload.`
      : null);
  attentionPanel.hidden = !syncProblem;
  syncAlert.hidden = !syncProblem;
  syncAlert.textContent = syncProblem || "";

  const tab = await activeTab();
  captureTab = null;
  captureSiteOrigin = null;
  captureSiteAccess = null;
  siteAccessPanel.hidden = true;
  saveCaptureReport.hidden = true;
  reportDescription.hidden = true;
  sherryTabId = tab?.url?.startsWith("https://shared-memory-ingestion.mufaddal-m25.workers.dev/") ? tab.id : null;
  connectSherry.hidden = !sherryTabId;
  connectSherry.disabled = !sherryTabId;
  const providerMatch = (tab?.url ?? "").match(/^https:\/\/(?:chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com)\//i);
  captureNow.disabled = !providerMatch || !captureEnabled.checked;
  captureNow.className = syncProblem ? "secondary" : "primary";
  activeCapture = null;
  repairChat.disabled = true;
  repairChat.hidden = true;
  repairExplainer.hidden = true;
  repairCount.hidden = true;
  if (!providerMatch) {
    pageStatus.textContent = "Open a ChatGPT, Claude, or Gemini chat.";
    scanStatus.textContent = "No supported conversation is open in this tab.";
    coverageNote.hidden = true;
    return;
  }
  coverageNote.hidden = false;

  captureTab = tab;
  captureSiteOrigin = `${new URL(tab.url).origin}/*`;
  captureSiteAccess = await persistentSiteAccess(captureSiteOrigin);
  saveCaptureReport.hidden = false;
  reportDescription.hidden = false;
  if (captureSiteAccess === false) {
    siteAccessPanel.hidden = false;
    siteAccessDescription.textContent = "Sherry does not have ongoing access to this site. Opening the popup gives temporary access, which can make capture appear to work only when you click it.";
    grantSiteAccess.textContent = globalThis.browser ? "Allow automatic capture on this site" : "Open extension site settings";
  }

  // Opening the status view must not inject a missing reader and hide a startup failure.
  const page = await tabMessage(tab.id, { type: "GET_CAPTURE_STATE" });
  if (!page?.ok) {
    pageStatus.textContent = captureSiteAccess === false
      ? "Automatic capture needs site access."
      : "Capture has not started on this page.";
    scanStatus.textContent = "No page scan is available.";
    showError(captureSiteAccess === false ? null : "Reload this chat once. If capture still has not started, save a troubleshooting report below.");
    return;
  }

  pageStatus.textContent = captureSiteAccess === false ? "Automatic capture needs site access."
    : captureSiteAccess === null ? "Could not verify automatic site access."
    : !captureEnabled.checked ? "Capture is paused."
    : !page.lastScanAt ? "Starting the first page scan…"
    : page.lastError ? "Capture needs attention."
    : Number.isInteger(page.lastScanReadable) && page.lastScanReadable < page.lastScanCandidates ? "Some messages could not be read."
    : page.conversationId ? `Reading this ${page.provider[0].toUpperCase()}${page.provider.slice(1)} conversation`
    : "Waiting for a conversation.";
  let localError = null;
  if (page.conversationId) {
    activeCapture = { provider: page.provider, conversationId: page.conversationId };
    const local = await runtimeMessage({ type: "COUNT_CONVERSATION_CAPTURES", payload: activeCapture });
    if (local?.ok) {
      repairCount.hidden = false;
      repairCount.textContent = `${local.count} saved on this device for this chat.`;
      repairChat.hidden = !cloudConnected || Boolean(ingestion.blockedReason) || !ingestion.quarantinedBatches || !local.count;
      repairExplainer.hidden = repairChat.hidden;
      repairChat.textContent = `Retry ${local.count} saved message${local.count === 1 ? "" : "s"} from this chat`;
      repairChat.disabled = Boolean(ingestion.pendingBatches) || !local.count;
    } else {
      localError = local?.error || "Could not count this chat's saved messages.";
    }
  }
  scanStatus.textContent = scanSummary(page);
  showError(page.lastError || localError);
}

captureEnabled.addEventListener("change", async () => {
  const requested = captureEnabled.checked;
  captureSettingSavePending = true;
  captureEnabled.disabled = true;
  showError(null);
  let saved = false;
  try {
    const receipt = await runtimeMessage({ type: "UPDATE_SETTINGS", payload: { captureEnabled: requested } });
    confirmedCaptureEnabled = receipt.settings?.captureEnabled ?? requested;
    saved = true;
    await refresh();
    if (receipt.recoveryWarning) showError(receipt.recoveryWarning);
  } catch (error) {
    captureEnabled.checked = confirmedCaptureEnabled ?? false;
    showError(saved
      ? `Capture was saved, but its status could not refresh: ${error.message}`
      : `Capture setting was not saved: ${error.message}`);
  } finally {
    captureSettingSavePending = false;
    captureEnabled.disabled = confirmedCaptureEnabled == null;
  }
});

grantSiteAccess.addEventListener("click", () => {
  if (!captureSiteOrigin) return;
  if (!globalThis.browser) {
    void extensionApi.tabs.create({ url: `chrome://extensions/?id=${extensionApi.runtime.id}` });
    return;
  }
  // Firefox requires the request directly in the user gesture, before any await.
  const request = extensionApi.permissions.request({ origins: [captureSiteOrigin] });
  grantSiteAccess.disabled = true;
  Promise.resolve(request).then(async (granted) => {
    if (!granted) { showError("Site access was not granted. Automatic capture remains unavailable here."); return; }
    if (captureTab) await ensureCaptureAdapter(captureTab);
    await refresh();
  }).catch((error) => showError(error.message)).finally(() => { grantSiteAccess.disabled = false; });
});

saveCaptureReport.addEventListener("click", async () => {
  if (!captureTab) return;
  const page = await tabMessage(captureTab.id, { type: "GET_CAPTURE_DIAGNOSTICS" });
  const report = {
    version: extensionApi.runtime.getManifest().version,
    capturedAt: new Date().toISOString(),
    site: new URL(captureTab.url).hostname,
    persistentSiteAccess: captureSiteAccess,
    captureEnabled: captureEnabled.checked,
    reader: page?.ok ? page.diagnostics : { available: false }
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "sherry-capture-report.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

captureNow.addEventListener("click", async () => {
  const tab = await activeTab();
  captureNow.disabled = true;
  const adapter = await ensureCaptureAdapter(tab);
  const response = adapter?.ok
    ? await tabMessage(tab.id, { type: "CAPTURE_NOW" })
    : adapter;
  showError(response?.ok ? null : response?.error || "Manual capture failed.");
  if (response?.candidates != null) scanStatus.textContent = scanSummary({ lastScanCandidates: response.candidates, lastScanReadable: response.readable, lastScanStored: response.stored ?? response.emitted ?? 0 });
  else if (response?.ok) scanStatus.textContent = "Page scan finished. Scroll up if older messages are missing from this page.";
  setTimeout(refresh, 250);
});

repairChat.addEventListener("click", async () => {
  if (!activeCapture) return;
  repairChat.disabled = true;
  repairStatus.hidden = false;
  repairStatus.textContent = "Preparing this chat’s saved messages for upload…";
  try {
    const response = await runtimeMessage({ type: "REUPLOAD_CONVERSATION", payload: activeCapture });
    repairStatus.textContent = `${response.ingestion.queuedEvents} saved messages queued. Keep this browser open until no uploads are waiting, then check this chat in Sherry.`;
    showError(null);
    await refresh();
  } catch (error) {
    repairStatus.textContent = "This chat was not queued for upload.";
    showError(error.message || "The repair upload could not start.");
    repairChat.disabled = false;
  }
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

refresh().catch((error) => {
  captureEnabled.disabled = true;
  captureSettingDescription.textContent = "Capture status unavailable. The setting has not been changed.";
  showError(error.message);
});
