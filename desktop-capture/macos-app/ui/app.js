const $ = (id) => document.getElementById(id);
const pending = new Map();
let sequence = 0;
let account = null;
let state = {};
let activePage = "capture";
let activeSource = "codex";
let logState = { captures: [], checks: {} };
let logSignature = null;
let refreshing = false;
let logError = null;
window.sherryResolve = (id, result) => {
  const task = pending.get(id);
  if (!task) return;
  pending.delete(id);
  result?.ok ? task.resolve(result.value) : task.reject(new Error(result?.error || "App action failed."));
};
function call(action, values = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    window.webkit.messageHandlers.sherry.postMessage({ id, action, ...values });
  });
}
const catalog = [
  { id: "codex", name: "Codex", icon: "</>", description: "Local conversation logs · prompts and final replies" },
  { id: "chatgpt", name: "ChatGPT · Unavailable", icon: "◎", description: "Desktop view cannot be identified · use the browser extension" },
  { id: "claude", name: "Claude", icon: "✳", description: "Visible ordinary chat through Accessibility" },
  { id: "antigravity", name: "Antigravity", icon: "◇", description: "Local transcript logs · prompts and completed replies" }
];
function message(text, error = false) { $("message").textContent = text || ""; $("message").className = error ? "error" : ""; }
function show() {
  $("auth").classList.toggle("hidden", !!account);
  $("dashboard").classList.toggle("hidden", !account);
  $("account").textContent = account ? `${account.workspaceName} · ${account.email}` : "";
  if (!account) { $("service").textContent = "Signed out"; $("service").className = "service"; }
}

function selectPage(page) {
  activePage = page;
  for (const name of ["capture", "test"]) {
    $(`${name}-tab`).setAttribute("aria-selected", String(name === page));
    $(`${name}-tab`).tabIndex = name === page ? 0 : -1;
    $(`${name}-panel`).classList.toggle("hidden", name !== page);
  }
  if (page === "test") { renderTest(); refresh(); }
}

function selectSource(source) {
  activeSource = source;
  logState = { captures: [], checks: {} }; logSignature = null; logError = null;
  for (const button of $("test-source-tabs").querySelectorAll("button")) {
    button.setAttribute("aria-selected", String(button.dataset.source === source));
    button.tabIndex = button.dataset.source === source ? 0 : -1;
  }
  $("test-source-panel").setAttribute("aria-labelledby", `test-${source}`);
  renderTest(); refresh();
}

function tabKeyboard(event) {
  const buttons = [...event.currentTarget.querySelectorAll('[role="tab"]')];
  const index = buttons.indexOf(document.activeElement);
  let next;
  if (event.key === "ArrowRight") next = (index + 1) % buttons.length;
  if (event.key === "ArrowLeft") next = (index + buttons.length - 1) % buttons.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = buttons.length - 1;
  if (next === undefined) return;
  event.preventDefault(); buttons[next].focus(); buttons[next].click();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function exactTime(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not supplied";
}

function renderTest() {
  const source = catalog.find((item) => item.id === activeSource);
  const name = source.name.split(" · ")[0];
  const enabled = state.sources?.[activeSource]?.enabled;
  const watching = enabled && state.paused === false;
  const visibleChat = activeSource === "claude";
  const check = logState.checks?.[activeSource];
  const readerDenied = /enable sherry desktop.*accessibility|accessibility.*(denied|permission)/i.test(check?.message || "");
  const needsPermission = visibleChat && (state.accessibilityGranted === false || readerDenied);
  $("test-permission").classList.toggle("hidden", !visibleChat);
  $("test-permission-message").textContent = needsPermission
    ? "The capture reader needs Accessibility access. Enable the current Sherry Desktop app in Settings. If its entry is already on but capture is denied, remove that entry and add the app shown in Finder."
    : "Enable this copy of Sherry Desktop in Accessibility. The older Sherry Accessibility Probe is a developer tool and is not required.";
  $("test-title").textContent = `${name} capture log`;
  $("test-description").textContent = activeSource === "chatgpt"
    ? "Desktop ChatGPT capture is unavailable because the shared app exposes Codex transcripts under the same layout. Use the browser extension. Earlier entries below may be Codex chats."
    : activeSource === "claude"
    ? "Visible Claude chat reader. Keep an ordinary conversation open."
    : "Send a new prompt after starting capture. Prompts and completed replies appear here as the local log is read.";
  $("test-start").textContent = activeSource === "chatgpt" ? "Desktop capture unavailable"
    : watching ? "Pause capture" : `Start testing ${name}`;
  $("test-start").disabled = activeSource === "chatgpt";
  const label = activeSource === "chatgpt" ? "ChatGPT desktop capture is disabled. Use the browser extension for ChatGPT."
    : needsPermission ? "Accessibility permission is missing for this Sherry build."
    : !enabled ? `${name} capture is off.` : state.paused !== false ? "Capture is paused."
    : check?.message || "Waiting for the first scan…";
  $("test-reader").textContent = logError ? `Could not refresh this log: ${logError}`
    : `${label}${check?.checkedAt ? ` Last scan: ${exactTime(check.checkedAt)}.` : ""}`;
  $("test-reader").className = `reader-status ${logError || (watching && check?.status === "waiting") ? "attention" : ""}`;
  const captures = logState.captures.filter((item) => item.source === activeSource).slice().reverse();
  const unverified = captures.filter((item) => item.source === "chatgpt" && item.sourceVerified !== true);
  $("test-count").textContent = activeSource === "chatgpt"
    ? `${captures.length} earlier turns · source unverified (may be Codex)`
    : `${captures.length} recent turns · ${captures.filter((item) => item.delivery === "uploaded").length} uploaded${unverified.length ? ` · ${unverified.length} earlier turns with unverified source` : ""}`;
  const signature = JSON.stringify([activeSource, captures]);
  if (signature === logSignature) return;
  logSignature = signature;
  const expanded = new Set([...$("test-log").querySelectorAll("details[open]")].map((node) => node.dataset.eventId));
  if (!captures.length) {
    const empty = element("div", "test-empty");
    empty.append(element("strong", "", "No captured turns yet"),
      element("p", "", "Start testing, then send a new prompt in this app. Only messages captured by this version appear here; earlier uploads are not downloaded."));
    $("test-log").replaceChildren(empty); return;
  }
  $("test-log").replaceChildren(...captures.map((item) => {
    const event = item.event;
    const card = element("article", "capture-entry");
    const header = element("div", "capture-entry-header");
    const role = event.role === "user" ? "You" : event.role === "assistant" ? name : event.role;
    const deliveryNames = { queued: "Captured · queued", uploaded: "Uploaded", retrying: "Captured · retrying", blocked: "Captured · upload blocked", rejected: "Captured · upload rejected" };
    header.append(element("strong", "capture-role", role),
      element("span", `delivery ${item.delivery}`, deliveryNames[item.delivery] || "Captured locally"));
    const title = element("div", "capture-conversation", event.chatTitle || event.conversationId || "Conversation");
    const text = element("pre", "capture-text", event.text || "(No text)");
    const time = element("div", "capture-time", `Captured ${exactTime(item.capturedAt)}${item.uploadedAt ? ` · Uploaded ${exactTime(item.uploadedAt)}` : ""}`);
    card.append(header, title, text, time);
    if (item.source === "chatgpt" && item.sourceVerified !== true) {
      card.prepend(element("p", "capture-error", "Source unverified: captured before the ChatGPT/Codex distinction was checked. This may be a Codex chat; its upload does not confirm ChatGPT capture."));
    }
    if (item.error) card.append(element("p", "capture-error", item.error));
    const details = element("details", "capture-details");
    details.dataset.eventId = event.eventId;
    details.open = expanded.has(event.eventId);
    details.append(element("summary", "", "Captured fields"), element("pre", "capture-fields", JSON.stringify({
      source: item.source, sourceVerified: item.sourceVerified === true, batchId: item.batchId, delivery: item.delivery,
      httpStatus: item.httpStatus, nextAttemptAt: item.nextAttemptAt, ...event
    }, null, 2)));
    card.append(details); return card;
  }));
}
function relativeTime(value) {
  if (!value) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  if (!Number.isFinite(minutes)) return "—";
  return minutes < 1 ? "Just now" : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}
function render() {
  const age = Date.now() - Date.parse(state.heartbeatAt || "");
  const running = Number.isFinite(age) && age < 90000 && state.running;
  $("service").textContent = running ? "Service running" : "Service starting";
  $("service").className = `service ${running ? "running" : "offline"}`;
  $("master-title").textContent = state.paused === false ? "Capture is on" : "Capture is paused";
  $("master-toggle").textContent = state.paused === false ? "Pause capture" : "Start capture";
  $("pending").textContent = state.pendingBatches ?? 0;
  $("quarantined").textContent = state.quarantinedBatches ?? 0;
  $("last-upload").textContent = relativeTime(state.lastUploadAt);
  $("sources").replaceChildren(...catalog.map((source) => {
    const row = document.createElement("div"); row.className = "source";
    const icon = document.createElement("span"); icon.className = "icon"; icon.textContent = source.icon;
    const copy = document.createElement("div"); copy.className = "source-copy";
    const name = document.createElement("div"); name.className = "source-name"; name.textContent = source.name;
    const description = document.createElement("div"); description.className = "source-description";
    const captured = state.sourceStats?.[source.id]?.capturedEvents || 0;
    description.textContent = source.id === "chatgpt" ? source.description
      : captured ? `${source.description} · ${captured} turns captured` : source.description;
    copy.append(name, description);
    const label = document.createElement("label"); label.className = "switch";
    const input = document.createElement("input"); input.type = "checkbox"; input.checked = !!state.sources?.[source.id]?.enabled;
    input.disabled = source.id === "chatgpt";
    input.setAttribute("aria-label", `Capture ${source.name}`);
    input.onchange = async () => {
      try { await call("source", { source: source.id, enabled: input.checked }); await refresh(); }
      catch (error) { input.checked = !input.checked; message(error.message, true); }
    };
    const slider = document.createElement("span"); slider.className = "slider";
    label.append(input, slider); row.append(icon, copy);
    if (source.id === "claude") {
      const check = document.createElement("button"); check.className = "check-button";
      check.textContent = "Check";
      check.setAttribute("aria-label", `Check visible ${source.name} conversation`);
      check.onclick = async () => {
        check.disabled = true; message(`Checking ${source.name}…`);
        try {
          const result = await call("verify", { source: source.id });
          message(result.surface === "claude_code"
            ? "Claude Code is open. For this MVP, switch to an ordinary Claude chat and check again."
            : `${source.name}: ${result.user} user and ${result.assistant} assistant turns visible (${result.textCharacters} characters).`);
        } catch (error) { message(error.message, true); }
        finally { check.disabled = false; }
      };
      row.append(check);
    }
    row.append(label); return row;
  }));
  if (state.lastError) message(state.lastError, true);
}
async function refresh() {
  if (!account || refreshing) return;
  refreshing = true;
  const requestedSource = activeSource;
  try {
    const status = await call("status");
    if (!account) return;
    state = status; render();
    if (activePage === "test") {
      try {
        const log = await call("captureLog", { source: requestedSource });
        if (!account || requestedSource !== activeSource) return;
        logState = log; logError = null;
        $("test-updated").textContent = `Updated ${new Date().toLocaleTimeString()} · every 2s`;
      } catch (error) { logError = error.message; }
      renderTest();
    }
  }
  catch (error) { message(error.message, true); }
  finally { refreshing = false; }
}
$("sign-in").onsubmit = async (event) => {
  event.preventDefault(); message("");
  const form = event.currentTarget;
  const button = $("sign-in-button"); button.disabled = true; button.textContent = "Connecting…";
  try {
    account = await call("signIn", { email: form.email.value.trim(), password: form.password.value });
    form.password.value = ""; show(); message("Connected. Capture is paused until you start it."); await refresh();
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; button.textContent = "Sign in"; }
};
$("sign-out").onclick = async () => {
  try { await call("signOut"); account = null; state = {}; logState = { captures: [], checks: {} };
    logSignature = null; $("test-log").replaceChildren(); show(); message("Signed out and capture paused."); }
  catch (error) { message(error.message, true); }
};
$("master-toggle").onclick = async () => {
  try { await call(state.paused === false ? "pause" : "enable"); await refresh(); message(state.paused ? "Capture paused." : "Capture started."); }
  catch (error) { message(error.message, true); }
};
$("accessibility").onclick = () => call("accessibility").catch((error) => message(error.message, true));
$("show-app").onclick = () => call("showApp").catch((error) => message(error.message, true));
$("test-show-app").onclick = $("show-app").onclick;
$("test-accessibility").onclick = $("accessibility").onclick;
$("capture-tab").onclick = () => selectPage("capture");
$("test-tab").onclick = () => selectPage("test");
document.querySelector(".page-tabs").onkeydown = tabKeyboard;
$("test-source-tabs").onkeydown = tabKeyboard;
for (const button of $("test-source-tabs").querySelectorAll("button")) button.onclick = () => selectSource(button.dataset.source);
$("test-start").onclick = async () => {
  if (activeSource === "chatgpt") return;
  const button = $("test-start"); button.disabled = true;
  try {
    if (state.paused === false && state.sources?.[activeSource]?.enabled) await call("pause");
    else {
      await call("source", { source: activeSource, enabled: true });
      await call("enable");
    }
    await refresh(); renderTest();
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
};
(async () => {
  try { account = await call("account"); show(); if (account) await refresh(); }
  catch (error) { show(); message(error.message, true); }
})();
setInterval(refresh, 2000);
