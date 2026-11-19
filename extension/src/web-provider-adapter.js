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
      startedAt: new Date().toISOString(),
      settings: { ...DEFAULT_SETTINGS },
      settingsLoaded: false,
      currentUrl: location.href,
      observer: null,
      pendingTurns: new Set(),
      settleTimer: null,
      pendingSince: null,
      capturedById: new Map(),
      metadataByConversation: new Map(),
      lastScanAt: null,
      lastScanCandidates: null,
      lastScanReadable: null,
      lastScanEmitted: 0,
      lastScanStored: 0,
      lastError: null,
      provisionalId: `pending:${config.provider}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      conversationId: null
    };

    const now = () => new Date().toISOString();

    function sendMessage(message) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: "Capture confirmation timed out. Sherry will retry." }), 10000);
        Promise.resolve().then(() => sendMessageAttempt(message)).then(resolve, (error) => resolve({ ok: false, error: error.message }))
          .finally(() => clearTimeout(timer));
      });
    }

    function sendMessageAttempt(message) {
      if (globalThis.browser) {
        return extensionApi.runtime.sendMessage(message)
          .then((response) => response ?? { ok: false, error: "The background service did not confirm this capture. It will be retried." })
          .catch((error) => ({ ok: false, error: error.message }));
      }
      return new Promise((resolve) => {
        extensionApi.runtime.sendMessage(message, (response) => {
          if (extensionApi.runtime.lastError) {
            resolve({ ok: false, error: extensionApi.runtime.lastError.message });
            return;
          }
          resolve(response ?? { ok: false, error: "The background service did not confirm this capture. It will be retried." });
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
      const title = core.browserTitle(config.provider, config.getTitle?.() || document.title);
      return {
        ...title,
        conversationId: conversationId
          || state.provisionalId,
        canonicalConversationId,
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

      const providerMessageId = config.getProviderMessageId?.(turn, role) || null;
      const messageTimestamp = config.getMessageTimestamp?.(turn) || null;
      return core.createCapturedEvent({
        sourceMetadata: core.browserSourceMetadata({ ...meta, providerMessageId, messageTimestamp, captureAttachments: state.settings.captureAttachments }),
        provider: config.provider,
        conversationId: meta.conversationId,
        providerMessageId,
        sequence,
        role,
        text,
        url: meta.url,
        title: meta.title,
        messageTimestamp,
        capturedAt: now(),
        links: extractLinks(turn),
        attachments: extractAttachments(turn)
      });
    }

    let scanChain = Promise.resolve();
    function captureTurns(turns, reason) {
      const scan = scanChain.catch(() => undefined).then(() => captureTurnsNow(turns, reason));
      scanChain = scan;
      return scan;
    }

    async function captureTurnsNow(turns, reason) {
      if (!state.settingsLoaded) await loadSettings();
      const startedAt = performance.now();
      const meta = getConversationMeta();
      const previousConversationId = state.conversationId;
      // Keep the old identity until reconciliation succeeds, so it can be retried.

      if (!state.settings.captureEnabled) {
        await emitDiagnostic("capture", "skipped", { reason: "disabled" });
        return { ok: false, error: "Capture is disabled for this chat.", candidates: 0, emitted: 0, stored: 0 };
      }
      if (meta.temporary && !state.settings.captureTemporaryChats) {
        await emitDiagnostic("capture", "skipped", { reason: "temporary_chat" });
        return { ok: false, error: "Capture is disabled for this chat.", candidates: 0, emitted: 0, stored: 0 };
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
          return { ok: false, error: state.lastError };
        }
      }

      state.conversationId = meta.conversationId;
      const allTurns = findInitialTurns();
      const sequenceByTurn = new Map(allTurns.map((turn, index) => [turn, index]));
      let failedReads = 0;
      const readableEvents = uniqueTopLevelTurns(turns)
        .filter((turn) => sequenceByTurn.has(turn))
        .map((turn) => {
          try { return extractEvent(turn, sequenceByTurn.get(turn), meta); }
          catch { failedReads += 1; return null; }
        })
        .filter(Boolean);
      const events = readableEvents.filter((event) => state.capturedById.get(event.eventId) !== event.contentHash);

      let stored = 0;
      let captureError = null;
      if (events.length) {
        const response = await sendMessage({ type: "CAPTURE_BATCH", payload: { events, reason, temporaryChat: meta.temporary } });
        if (response?.ok) {
          events.forEach((event) => state.capturedById.set(event.eventId, event.contentHash));
          stored = (response.result?.added || 0) + (response.result?.updated || 0);
          state.lastError = null;
        } else {
          state.lastError = response?.error || "Capture upload failed";
          captureError = state.lastError;
          await emitDiagnostic("capture", "error", { reason, message: state.lastError });
        }
      }

      // Title observations have their own acknowledgment and never enter message deduplication.
      const metadataKey = JSON.stringify([meta.conversationId, meta.title, meta.titleBasis, Boolean(meta.canonicalConversationId)]);
      if (!captureError && state.capturedById.size && !core.isProvisionalConversationId(meta.conversationId)
          && state.metadataByConversation.get(meta.conversationId) !== metadataKey) {
        const response = await sendMessage({ type: "CONVERSATION_METADATA", payload: {
          provider: config.provider, conversationId: meta.conversationId, chatTitle: meta.title, capturedAt: now(),
          sourceMetadata: { version: 1, titleBasis: meta.titleBasis, conversationIdentity: meta.canonicalConversationId ? "provider" : "local", messageIdentity: "unknown", timestampBasis: "unknown", linksStatus: "unknown", attachmentsStatus: "unknown" }
        } });
        if (response?.ok) {
          if (response.result?.retained !== false) state.metadataByConversation.set(meta.conversationId, metadataKey);
        } else { captureError = response?.error || "Title observation could not be saved. Sherry will retry."; state.lastError = captureError; }
      }

      state.lastScanAt = now();
      state.lastScanCandidates = allTurns.length;
      state.lastScanReadable = reason === "mutation" ? null : readableEvents.length;
      state.lastScanEmitted = events.length;
      state.lastScanStored = stored;
      if (failedReads) state.lastError = `${failedReads} message${failedReads === 1 ? "" : "s"} could not be read. Sherry will retry.`;
      if (failedReads) await emitDiagnostic("extract", "error", { reason, failedReads });
      if (reason !== "periodic_scan" || events.length) {
        await emitDiagnostic("scan", "ok", {
          reason,
          candidates: allTurns.length,
          readable: state.lastScanReadable,
          emitted: events.length,
          stored,
          failedReads,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
          conversationId: meta.conversationId
        });
      }
      return { ok: !captureError && !failedReads, error: captureError || (failedReads ? state.lastError : null), candidates: allTurns.length, readable: state.lastScanReadable, emitted: events.length, stored };
    }

    function schedulePendingCapture(reason = "mutation") {
      state.pendingSince ??= Date.now();
      clearTimeout(state.settleTimer);
      state.settleTimer = setTimeout(async () => {
        const turns = [...state.pendingTurns];
        state.pendingTurns.clear();
        state.pendingSince = null;
        if (turns.length) await captureTurns(turns, reason).catch((error) => { state.lastError = error.message; });
      }, Math.min(config.settleMs || 900, Math.max(0, 3000 - (Date.now() - state.pendingSince))));
    }

    function observeConversation() {
      state.observer?.disconnect();
      state.observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          addCandidateTurns(mutation.target);
          mutation.addedNodes.forEach(addCandidateTurns);
        }
        if (state.pendingTurns.size) schedulePendingCapture();
      });
      state.observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    }

    async function loadSettings() {
      const stored = await extensionApi.storage.sync.get(DEFAULT_SETTINGS);
      state.settings = { ...DEFAULT_SETTINGS, ...stored };
      state.settingsLoaded = true;
    }

    async function initialCapture() {
      const turns = findInitialTurns();
      void emitDiagnostic("page_detected", "ok", {
        conversationId: getConversationMeta().conversationId,
        initialCandidates: turns.length
      }).catch(() => undefined);
      return captureTurns(turns, "initial_scan");
    }

    function captureDiagnostics() {
      const turns = findInitialTurns();
      return {
        available: true,
        provider: config.provider,
        startedAt: state.startedAt,
        settingsLoaded: state.settingsLoaded,
        observerAttached: Boolean(state.observer),
        pageVisibility: document.visibilityState,
        lastScanAt: state.lastScanAt,
        hasCaptureError: Boolean(state.lastError),
        messageAreaCount: turns.length,
        messageAreas: turns.slice(0, 200).map((turn, index) => {
          const role = config.detectRole(turn);
          const body = config.findMessageNode(turn, role) || turn;
          const rendering = [];
          for (let node = body; node && rendering.length < 12; node = node.parentElement) {
            const style = globalThis.getComputedStyle?.(node);
            if (style) rendering.push({
              tag: node.tagName?.toLowerCase() || null,
              display: style.display,
              visibility: style.visibility,
              contentVisibility: style.contentVisibility,
              hidden: Boolean(node.hidden),
              ariaHidden: node.getAttribute?.("aria-hidden") === "true"
            });
            if (node === document.body) break;
          }
          return {
            position: index + 1,
            role,
            turnTag: turn.tagName?.toLowerCase() || null,
            bodyTag: body.tagName?.toLowerCase() || null,
            renderedCharacters: core.normalizeText(body.innerText).length,
            loadedCharacters: core.normalizeText(body.textContent).length,
            hasOpenShadowRoot: Boolean(turn.shadowRoot),
            rendering,
            ...(config.diagnoseTurn ? { messageBodies: config.diagnoseTurn(turn, role) } : {})
          };
        })
      };
    }

    extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "GET_CAPTURE_DIAGNOSTICS") {
        try { sendResponse({ ok: true, diagnostics: captureDiagnostics() }); }
        catch { sendResponse({ ok: false }); }
        return false;
      }
      if (message?.type === "GET_CAPTURE_STATE") {
        sendResponse({
          ok: true,
          provider: config.provider,
          enabled: state.settings.captureEnabled,
          conversationId: state.conversationId,
          lastScanAt: state.lastScanAt,
          lastScanCandidates: state.lastScanCandidates,
          lastScanReadable: state.lastScanReadable,
          lastScanEmitted: state.lastScanEmitted,
          lastScanStored: state.lastScanStored,
          lastError: state.lastError,
          url: location.href
        });
        return false;
      }
      if (message?.type === "CAPTURE_NOW") {
        captureTurns(findInitialTurns(), "manual")
          .then((result) => sendResponse({ ok: true, ...result }))
          .catch((error) => sendResponse({ ok: false, error: error.message }));
        return true;
      }
      if (message?.type === "SETTINGS_CHANGED" || message?.type === "RESUME_CAPTURE") {
        resumeCapture().then((result) => sendResponse(result || { ok: true }));
        return true;
      }
      return false;
    });

    async function resumeCapture() {
      try {
        await loadSettings();
        observeConversation();
        return await initialCapture();
      } catch (error) {
        state.lastError = error.message;
        return { ok: false, error: state.lastError };
      }
    }

    async function boot() {
      setInterval(() => {
        if (location.href === state.currentUrl) return;
        // A new chat in the same tab gets a separate provisional identity.
        if (!core.parseConversationIdFromUrl(location.href, config.provider)) {
          state.provisionalId = `pending:${config.provider}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
          state.conversationId = null;
        }
        state.currentUrl = location.href;
        state.capturedById.clear();
        void resumeCapture();
      }, 1000);
      setInterval(() => {
        if (document.visibilityState === "hidden") return;
        if (!state.settingsLoaded || !state.observer) { void resumeCapture(); return; }
        void captureTurns(findInitialTurns(), "periodic_scan").catch((error) => { state.lastError = error.message; });
      }, 5000);
      document.addEventListener?.("visibilitychange", () => {
        if (document.visibilityState !== "hidden") void resumeCapture();
      });
      globalThis.addEventListener?.("pageshow", () => { void resumeCapture(); });
      await resumeCapture();
    }

    boot().catch(async (error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
      await emitDiagnostic("adapter_start", "error", { message: state.lastError });
    });
  }

  globalThis.SharedMemoryWebProviderAdapter = Object.freeze({ start });
})();
