(() => {
  "use strict";

  const adapter = globalThis.SharedMemoryWebProviderAdapter;
  const core = globalThis.SharedMemoryCaptureCore;
  if (!adapter || !core) return;

  const turnSelector = [
    "user-query",
    "model-response",
    "[data-test-id='user-query']",
    "[data-test-id='model-response']"
  ].join(",");

  function detectRole(turn) {
    const tag = turn.tagName.toLowerCase();
    const signal = `${tag} ${turn.getAttribute("data-test-id") || ""} ${turn.getAttribute("aria-label") || ""}`;
    if (/user-query|you said/i.test(signal)) return "user";
    if (/model-response|gemini responded|assistant/i.test(signal)) return "assistant";
    return "unknown";
  }

  function findMessageNode(turn, role) {
    const selectors = role === "user"
      ? [".query-text", ".user-query-bubble-container", "[data-test-id='user-query-text']"]
      : [
          ".model-response-text",
          "message-content",
          ".markdown",
          ".response-content",
          "[data-test-id='model-response-text']"
        ];
    for (const selector of selectors) {
      const node = turn.querySelector(selector);
      if (node && core.normalizeText(node.innerText)) return node;
    }
    return turn;
  }

  function getProviderMessageId(turn) {
    return turn.getAttribute("data-message-id")
      || turn.getAttribute("data-turn-id")
      || null;
  }

  adapter.start({
    provider: "gemini",
    turnSelector,
    detectRole,
    findMessageNode,
    getProviderMessageId,
    getMessageTimestamp(turn) {
      return turn.querySelector("time[datetime]")?.getAttribute("datetime") || null;
    },
    getTemporarySignal() {
      return document.querySelector("[aria-label*='Temporary' i],[data-test-id*='temporary' i]")?.textContent || "";
    },
    getTitle() {
      return document.title.replace(/\s*[|—-]\s*Gemini\s*$/i, "").trim() || "Gemini conversation";
    }
  });
})();
