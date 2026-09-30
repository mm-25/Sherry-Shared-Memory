(() => {
  "use strict";

  const core = globalThis.SharedMemoryCaptureCore;
  if (!core) return;
  const extensionApi = globalThis.browser ?? globalThis.chrome;

  const DEFAULT_SETTINGS = {
    captureEnabled: true,
    captureAttachments: false,
    captureTemporaryChats: false,
    debugMode: true
  };

  function start(config) {
    if (!config?.provider || !config?.turnSelector) return;
    if (!core.isSupportedProviderUrl(config.provider, location.href)) return;
    if (globalThis.__sherryWebProviderAdapterStarted === config.provider) return;
    globalThis.__sherryWebProviderAdapterStarted = config.provider;

    const state = {
      settings: { ...DEFAULT_SETTINGS },
      currentUrl: location.href,
      observer: null,
      pendingTurns: new Set(),
      settleTimer: null,
      capturedById: new Map(),
      lastScanAt: null,
      lastError: null,
      conversationId: null
    };

    const now = () => new Date().toISOString();

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
          provider: config.provider,
          stage,
          status,
          at: now(),
          url: location.href,
          detail
        }
      });
    }

    function getConversationMeta() {
      const canonicalConversationId = core.parseConversationIdFromUrl(location.href, config.provider);
      const pageIdentity = config.getPageIdentity?.() || "";
      const conversationId = canonicalConversationId
        || core.parseConversationId(location.href, pageIdentity, config.provider);
      return {
        conversationId: conversationId
          || `pending:${core.fnv1a(`${config.provider}|${location.origin}${location.pathname}|${document.title}`)}`,
        canonicalConversationId,
        title: config.getTitle?.() || document.title || `${config.provider} conversation`,
        url: location.href,
        temporary: core.isLikelyTemporaryChat(location.href, config.getTemporarySignal?.() || "")
      };
    }

    function closestTurn(node) {
      if (!(node instanceof Element)) return node?.parentElement?.closest?.(config.turnSelector) ?? null;
      if (node.matches(config.turnSelector)) return node;
      return node.closest(config.turnSelector);
    }

    function addCandidateTurns(node) {
      if (!(node instanceof Element)) {
        const parentTurn = closestTurn(node);
        if (parentTurn) state.pendingTurns.add(parentTurn);
        return;
      }

      const ownTurn = closestTurn(node);
      if (ownTurn) state.pendingTurns.add(ownTurn);
      node.querySelectorAll?.(config.turnSelector).forEach((turn) => state.pendingTurns.add(turn));
    }

    function uniqueTopLevelTurns(elements) {
      const unique = [...new Set(elements)];
      return unique.filter((candidate) => !unique.some(
        (other) => other !== candidate && other.contains(candidate)
      ));
    }

    function findInitialTurns() {
      return uniqueTopLevelTurns([...document.querySelectorAll(config.turnSelector)]);
    }

    function extractLinks(turn) {
      return [...turn.querySelectorAll("a[href]")]
        .map((link) => link.href)
        .filter((href) => /^https?:/i.test(href));
    }

    function extractAttachments(turn) {
      if (!state.settings.captureAttachments) return [];
      return [...turn.querySelectorAll("a[download], img[src], [data-testid*='attachment'], [class*='attachment']")]
        .slice(0, 20)
        .map((element) => ({
          kind: element.tagName.toLowerCase(),
          name: core.normalizeText(
            element.getAttribute("download") || element.getAttribute("alt") || element.textContent
          ),
          url: element.href || element.src || null
        }))
        .filter((attachment) => attachment.name || attachment.url);
    }

    function extractEvent(turn, sequence, meta) {
      const role = config.detectRole(turn);
      const messageNode = config.findMessageNode(turn, role) || turn;
      const text = core.normalizeText(config.extractText?.(messageNode, turn, role) ?? messageNode.innerText);
      if (!text || role === "unknown" || core.isTransientAssistantStatus(role, text)) return null;

      return core.createCapturedEvent({
        provider: config.provider,
        conversationId: meta.conversationId,
        providerMessageId: config.getProviderMessageId?.(turn, role) || null,
        sequence,
        role,
        text,
        url: meta.url,
        title: meta.title,
        messageTimestamp: config.getMessageTimestamp?.(turn) || null,
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
        return;
      }
      if (meta.temporary && !state.settings.captureTemporaryChats) {
        await emitDiagnostic("capture", "skipped", { reason: "temporary_chat" });
        return;
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
      const events = uniqueTopLevelTurns(turns)
        .map((turn) => extractEvent(turn, sequenceByTurn.get(turn) ?? allTurns.indexOf(turn), meta))
        .filter(Boolean)
        .filter((event) => state.capturedById.get(event.eventId) !== event.contentHash);

      if (events.length) {
        const response = await sendMessage({ type: "CAPTURE_BATCH", payload: { events, reason } });
        if (response?.ok) {
          events.forEach((event) => state.capturedById.set(event.eventId, event.contentHash));
          state.lastError = null;
        } else {
          state.lastError = response?.error || "Capture upload failed";
          await emitDiagnostic("capture", "error", { reason, message: state.lastError });
        }
      }

      state.lastScanAt = now();
      await emitDiagnostic("scan", "ok", {
        reason,
        candidates: turns.length,
        emitted: events.length,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        conversationId: meta.conversationId
      });
    }

    function schedulePendingCapture(reason = "mutation") {
      clearTimeout(state.settleTimer);
      state.settleTimer = setTimeout(async () => {
        const turns = [...state.pendingTurns];
        state.pendingTurns.clear();
        if (turns.length) await captureTurns(turns, reason);
      }, config.settleMs || 900);
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
      state.observer.observe(document.body, { childList: true, characterData: true, subtree: true });
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
          provider: config.provider,
          enabled: state.settings.captureEnabled,
          conversationId: state.conversationId,
          lastScanAt: state.lastScanAt,
          lastError: state.lastError,
          url: location.href
        });
        return false;
      }
      if (message?.type === "CAPTURE_NOW") {
        captureTurns(findInitialTurns(), "manual").then(() => sendResponse({ ok: true }));
        return true;
      }
      if (message?.type === "SETTINGS_CHANGED") {
        loadSettings().then(() => sendResponse({ ok: true }));
        return true;
      }
      return false;
    });

    async function boot() {
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

    boot().catch(async (error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
      await emitDiagnostic("adapter_start", "error", { message: state.lastError });
    });
  }

  globalThis.SharedMemoryWebProviderAdapter = Object.freeze({ start });
})();
