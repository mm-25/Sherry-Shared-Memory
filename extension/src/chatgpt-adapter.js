(() => {
  "use strict";

  const core = globalThis.SharedMemoryCaptureCore;
  if (!core || !core.isSupportedChatGptUrl(location.href)) return;
  if (globalThis.__sherryChatGptAdapterStarted) return;
  globalThis.__sherryChatGptAdapterStarted = true;
  const extensionApi = globalThis.browser ?? globalThis.chrome;

  const TURN_SELECTOR = [
    "[data-turn-key]",
    "[data-testid^='conversation-turn-']",
    "article[data-testid^='conversation-turn-']",
    "[data-message-author-role]"
  ].join(",");

  const DEFAULT_SETTINGS = {
    captureEnabled: true,
    captureAttachments: false,
    captureTemporaryChats: false,
    debugMode: true
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    currentUrl: location.href,
    observer: null,
    pendingTurns: new Set(),
    settleTimer: null,
    capturedById: new Map(),
    lastScanAt: null,
    lastScanCandidates: null,
    lastScanEmitted: null,
    lastScanStored: null,
    lastError: null,
    conversationId: null
  };

  function now() {
    return new Date().toISOString();
  }

  function sendMessage(message) {
    if (globalThis.browser) {
      return extensionApi.runtime.sendMessage(message)
        .then((response) => response ?? { ok: true })
        .catch((error) => ({ ok: false, error: error.message }));
    }
    return new Promise((resolve) => {
      extensionApi.runtime.sendMessage(message, (response) => {
        if (extensionApi.runtime.lastError) {
          resolve({ ok: false, error: extensionApi.runtime.lastError.message });
          return;
        }
        resolve(response ?? { ok: true });
      });
    });
  }

  async function emitDiagnostic(stage, status, detail = {}) {
    if (!state.settings.debugMode && status === "ok") return;
    await sendMessage({
      type: "DIAGNOSTIC_EVENT",
      payload: {
        provider: "chatgpt",
        stage,
        status,
        at: now(),
        url: location.href,
        detail
      }
    });
  }

  function getConversationRegionLabel() {
    const region = document.querySelector("[aria-label^='Conversation ']");
    return region?.getAttribute("aria-label") ?? "";
  }

  function getTemporaryChatSignal() {
    const indicator = document.querySelector([
      "[data-testid='temporary-chat-indicator']",
      "[data-state='temporary']",
      "[aria-current='page'][aria-label*='Temporary' i]"
    ].join(","));
    return indicator?.getAttribute("aria-label") || indicator?.textContent || "";
  }

  function getConversationMeta() {
    const canonicalConversationId = core.parseConversationIdFromUrl(location.href);
    const conversationId = canonicalConversationId
      || core.parseConversationId(location.href, getConversationRegionLabel());
    return {
      conversationId: conversationId || `pending:${core.fnv1a(`${location.origin}${location.pathname}|${document.title}`)}`,
      canonicalConversationId,
      title: document.title.replace(/\s*[|—-]\s*ChatGPT\s*$/i, "").trim() || "ChatGPT conversation",
      url: location.href,
      temporary: core.isLikelyTemporaryChat(location.href, getTemporaryChatSignal())
    };
  }

  function closestTurn(node) {
    if (!(node instanceof Element)) return node?.parentElement?.closest?.(TURN_SELECTOR) ?? null;
    if (node.matches(TURN_SELECTOR)) return node;
    return node.closest(TURN_SELECTOR);
  }

  function addCandidateTurns(node) {
    if (!(node instanceof Element)) {
      const parentTurn = closestTurn(node);
      if (parentTurn) state.pendingTurns.add(parentTurn);
      return;
    }

    const ownTurn = closestTurn(node);
    if (ownTurn) state.pendingTurns.add(ownTurn);
    node.querySelectorAll?.(TURN_SELECTOR).forEach((turn) => state.pendingTurns.add(turn));
  }

  function uniqueTopLevelTurns(elements) {
    const unique = [...new Set(elements)];
    return unique.filter((candidate) => !unique.some((other) => other !== candidate && other.contains(candidate)));
  }

  function expandTurn(turn) {
    if (!turn.matches("[data-turn-key]")) return [turn];
    // ChatGPT's newer layout wraps a user message and its assistant response
    // in one data-turn-key element. Keep them as separate captured events.
    const headings = [...turn.querySelectorAll("h4")].filter((heading) =>
      /^(you said|chatgpt said):?$/i.test(heading.textContent?.trim() || "")
    );
    return headings.length ? headings.map((heading) => heading.parentElement).filter(Boolean) : [turn];
  }

  function findInitialTurns() {
    return uniqueTopLevelTurns([...document.querySelectorAll(TURN_SELECTOR)]).flatMap(expandTurn);
  }

  function detectRole(turn) {
    const roleNode = turn.matches("[data-message-author-role]")
      ? turn
      : turn.querySelector("[data-message-author-role]");
    const explicitRole = roleNode?.getAttribute("data-message-author-role");
    if (explicitRole === "user" || explicitRole === "assistant") return explicitRole;

    const testId = turn.getAttribute("data-testid") ?? "";
    if (/user/i.test(testId)) return "user";
    if (/assistant/i.test(testId)) return "assistant";

    const aria = `${turn.getAttribute("aria-label") ?? ""} ${turn.innerText?.slice(0, 120) ?? ""}`;
    if (/\byou said\b|\buser\b/i.test(aria)) return "user";
    if (/\bchatgpt said\b|\bassistant\b/i.test(aria)) return "assistant";
    return "unknown";
  }

  function findMessageNode(turn, role) {
    const selectors = role === "user"
      ? ["[data-message-author-role='user']", "[data-testid='user-message']", ".whitespace-pre-wrap"]
      : ["[data-message-author-role='assistant'] .markdown", "[data-message-author-role='assistant']", ".markdown.prose", ".markdown"];

    for (const selector of selectors) {
      const match = turn.matches(selector) ? turn : turn.querySelector(selector);
      if (match && core.normalizeText(match.innerText)) return match;
    }
    return turn;
  }

  function getProviderMessageId(turn) {
    const idNode = turn.matches("[data-message-id]") ? turn : turn.querySelector("[data-message-id]");
    const messageId = idNode?.getAttribute("data-message-id");
    if (messageId) return messageId;

    const groupKey = turn.closest("[data-turn-key]")?.getAttribute("data-turn-key");
    if (groupKey) return `${groupKey}:${detectRole(turn)}`;

    const testId = turn.getAttribute("data-testid");
    if (testId?.startsWith("conversation-turn-")) return testId;

    return turn.id || null;
  }

  function extractLinks(turn) {
    return [...turn.querySelectorAll("a[href]")]
      .map((link) => link.href)
      .filter((href) => /^https?:/i.test(href));
  }

  function extractAttachments(turn) {
    if (!state.settings.captureAttachments) return [];
    return [...turn.querySelectorAll("a[download], img[src], [data-testid*='attachment']")]
      .slice(0, 20)
      .map((element) => ({
        kind: element.tagName.toLowerCase(),
        name: core.normalizeText(element.getAttribute("download") || element.getAttribute("alt") || element.textContent),
        url: element.href || element.src || null
      }))
      .filter((attachment) => attachment.name || attachment.url);
  }

  function extractEvent(turn, sequence, meta) {
    const role = detectRole(turn);
    const messageNode = findMessageNode(turn, role);
    const text = core.normalizeText(messageNode?.innerText)
      .replace(/^(?:You said|ChatGPT said):?\s*/i, "");
    if (!text || role === "unknown" || core.isTransientAssistantStatus(role, text)) return null;

    const time = turn.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
    return core.createCapturedEvent({
      conversationId: meta.conversationId,
      providerMessageId: getProviderMessageId(turn),
      sequence,
      role,
      text,
      url: meta.url,
      title: meta.title,
      messageTimestamp: time,
      capturedAt: now(),
      links: extractLinks(turn),
      attachments: extractAttachments(turn)
    });
  }

  async function captureTurns(turns, reason) {
    const startedAt = performance.now();
    const meta = getConversationMeta();
    const previousConversationId = state.conversationId;
    state.conversationId = meta.conversationId;

    if (!state.settings.captureEnabled) {
      await emitDiagnostic("capture", "skipped", { reason: "disabled" });
      return { ok: false, error: "Capture is disabled in Sherry Capture settings." };
    }
    if (meta.temporary && !state.settings.captureTemporaryChats) {
      await emitDiagnostic("capture", "skipped", { reason: "temporary_chat" });
      return { ok: false, error: "Temporary-chat capture is disabled in Sherry Capture settings." };
    }

    if (
      meta.canonicalConversationId
      && previousConversationId !== meta.conversationId
      && core.isProvisionalConversationId(previousConversationId)
    ) {
      const response = await sendMessage({
        type: "REKEY_CONVERSATION",
        payload: {
          fromConversationId: previousConversationId,
          toConversationId: meta.conversationId,
          sourceUrl: meta.url
        }
      });
      if (response?.ok) {
        state.capturedById.clear();
        await emitDiagnostic("conversation_rekey", "ok", {
          fromConversationId: previousConversationId,
          toConversationId: meta.conversationId,
          ...response.result
        });
      } else {
        state.lastError = response?.error || "Conversation identity reconciliation failed";
        await emitDiagnostic("conversation_rekey", "error", {
          fromConversationId: previousConversationId,
          toConversationId: meta.conversationId,
          message: state.lastError
        });
      }
    }

    const allTurns = findInitialTurns();
    const sequenceByTurn = new Map(allTurns.map((turn, index) => [turn, index]));
    const events = uniqueTopLevelTurns(turns).flatMap(expandTurn)
      .map((turn) => extractEvent(turn, sequenceByTurn.get(turn) ?? allTurns.indexOf(turn), meta))
      .filter(Boolean)
      .filter((event) => state.capturedById.get(event.eventId) !== event.contentHash);

    let captureError = null;
    let storedChanges = 0;
    if (events.length) {
      const response = await sendMessage({ type: "CAPTURE_BATCH", payload: { events, reason } });
      if (response?.ok) {
        events.forEach((event) => state.capturedById.set(event.eventId, event.contentHash));
        storedChanges = Number(response.result?.added || 0) + Number(response.result?.updated || 0);
      } else {
        state.lastError = response?.error || "Capture upload failed";
        captureError = state.lastError;
      }
    }

    state.lastScanAt = now();
    state.lastScanCandidates = allTurns.length;
    state.lastScanEmitted = events.length;
    state.lastScanStored = storedChanges;
    await emitDiagnostic("scan", "ok", {
      reason,
      candidates: turns.length,
      emitted: events.length,
      stored: storedChanges,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      conversationId: meta.conversationId
    });
    return captureError
      ? { ok: false, error: captureError, candidates: allTurns.length, emitted: events.length, stored: storedChanges }
      : { ok: true, candidates: allTurns.length, emitted: events.length, stored: storedChanges };
  }

  function schedulePendingCapture(reason = "mutation") {
    clearTimeout(state.settleTimer);
    state.settleTimer = setTimeout(async () => {
      const turns = [...state.pendingTurns];
      state.pendingTurns.clear();
      if (turns.length) await captureTurns(turns, reason);
    }, 900);
  }

  function observeConversation() {
    state.observer?.disconnect();
    state.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") addCandidateTurns(mutation.target);
        mutation.addedNodes.forEach(addCandidateTurns);
      }
      if (state.pendingTurns.size) schedulePendingCapture();
    });

    state.observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  async function loadSettings() {
    const stored = await extensionApi.storage.sync.get(DEFAULT_SETTINGS);
    state.settings = { ...DEFAULT_SETTINGS, ...stored };
  }

  async function initialCapture() {
    const turns = findInitialTurns();
    turns.forEach((turn) => state.pendingTurns.add(turn));
    await emitDiagnostic("page_detected", "ok", {
      conversationId: getConversationMeta().conversationId,
      initialCandidates: turns.length
    });
    if (turns.length) await captureTurns(turns, "initial_scan");
  }

  extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_CAPTURE_STATE") {
      sendResponse({
        ok: true,
        provider: "chatgpt",
        enabled: state.settings.captureEnabled,
        conversationId: state.conversationId,
        lastScanAt: state.lastScanAt,
        lastScanCandidates: state.lastScanCandidates,
        lastScanEmitted: state.lastScanEmitted,
        lastScanStored: state.lastScanStored,
        lastError: state.lastError,
        url: location.href
      });
      return false;
    }

    if (message?.type === "CAPTURE_NOW") {
      captureTurns(findInitialTurns(), "manual").then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "SETTINGS_CHANGED") {
      loadSettings().then(() => sendResponse({ ok: true }));
      return true;
    }

    return false;
  });

  async function start() {
    await loadSettings();
    observeConversation();
    await initialCapture();

    setInterval(async () => {
      if (location.href === state.currentUrl) return;
      state.currentUrl = location.href;
      state.capturedById.clear();
      await emitDiagnostic("navigation", "ok", { url: location.href });
      setTimeout(initialCapture, 500);
    }, 1000);
  }

  start().catch(async (error) => {
    state.lastError = error instanceof Error ? error.message : String(error);
    await emitDiagnostic("adapter_start", "error", { message: state.lastError });
  });
})();
