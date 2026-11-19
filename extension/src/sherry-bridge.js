(() => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  if (!extensionApi?.runtime) return;
  const version = extensionApi.runtime.getManifest().version;
  if (globalThis.__sherryCaptureBridgeVersion === version && document.getElementById("sherry-capture-bridge")) return;
  globalThis.__sherryCaptureBridgeVersion = version;
  const PAGE_SOURCE = "sherry-web-app";
  const BRIDGE_SOURCE = "sherry-extension-bridge";
  const REQUEST_EVENT = "sherry-capture-request";
  const RESPONSE_EVENT = "sherry-capture-response";
  const READY_EVENT = "sherry-capture-ready";
  const allowedTypes = new Set(["GET_STATUS", "UPDATE_SETTINGS", "UPDATE_INGESTION_CONFIG", "CLEAR_INGESTION_CONFIG", "RETRY_UPLOADS", "REUPLOAD_EXISTING"]);
  const requests = new Map();

  function runtimeMessage(message) {
    if (globalThis.browser) return extensionApi.runtime.sendMessage(message);
    return new Promise((resolve, reject) => {
      extensionApi.runtime.sendMessage(message, (response) => {
        const error = extensionApi.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function parseRequest(value) {
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch { return null; }
    }
    return value && typeof value === "object" ? value : null;
  }

  function publish(requestId, response) {
    const payload = { source: BRIDGE_SOURCE, requestId, response };
    document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: JSON.stringify(payload) }));
    window.postMessage(payload, location.origin);
  }

  async function processRequest(request) {
    if (request.type === "PING") {
      return { ok: true, bridgeVersion: extensionApi.runtime.getManifest().version };
    }
    if (!allowedTypes.has(request.type)) {
      return { ok: false, error: "Unsupported extension control request." };
    }
    try {
      return await runtimeMessage({ type: request.type, payload: request.payload });
    } catch (error) {
      return { ok: false, error: error?.message || "The extension background process did not respond." };
    }
  }

  async function handleRequest(value, mailboxNode = null) {
    const request = parseRequest(value);
    if (request?.source !== PAGE_SOURCE || typeof request.requestId !== "string") return;
    let pending = requests.get(request.requestId);
    if (!pending) {
      pending = processRequest(request);
      requests.set(request.requestId, pending);
      setTimeout(() => requests.delete(request.requestId), 10_000);
    }
    const response = await pending;
    if (mailboxNode) {
      mailboxNode.textContent = JSON.stringify({ source: BRIDGE_SOURCE, requestId: request.requestId, response });
      mailboxNode.dataset.sherryResponse = "true";
    }
    publish(request.requestId, response);
  }

  const previousMailbox = document.getElementById("sherry-capture-bridge");
  if (previousMailbox) previousMailbox.remove();
  const mailbox = document.createElement("div");
  mailbox.id = "sherry-capture-bridge";
  mailbox.hidden = true;
  mailbox.dataset.version = version;
  document.documentElement.append(mailbox);
  const mailboxObserver = new MutationObserver(() => {
    mailbox.querySelectorAll("[data-sherry-request-id]:not([data-sherry-request-seen])").forEach((node) => {
      node.dataset.sherryRequestSeen = "true";
      void handleRequest(node.textContent, node);
    });
  });
  mailboxObserver.observe(mailbox, { childList: true, subtree: true });

  document.addEventListener(REQUEST_EVENT, (event) => void handleRequest(event.detail));
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    void handleRequest(event.data);
  });

  document.documentElement.dataset.sherryCaptureBridge = version;
  document.dispatchEvent(new CustomEvent(READY_EVENT, { detail: version }));
})();
