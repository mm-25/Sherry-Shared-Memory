(() => {
  "use strict";

  const adapter = globalThis.SharedMemoryWebProviderAdapter;
  const core = globalThis.SharedMemoryCaptureCore;
  if (!adapter || !core) return;

  const turnSelector = [
    "[aria-label^='Message '][aria-label*=' of ']",
    "[data-testid^='conversation-turn-']",
    "[data-testid='user-message']",
    "[data-testid='assistant-message']"
  ].join(",");

  function textFromHeadings(turn) {
    return [...turn.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']")]
      .map((node) => core.normalizeText(node.innerText || node.textContent))
      .join(" ");
  }

  function detectRole(turn) {
    if (turn.matches("[data-testid='user-message']") || turn.querySelector("[data-testid='user-message']")) {
      return "user";
    }
    if (
      turn.matches("[data-testid='assistant-message'],[data-is-streaming]")
      || turn.querySelector("[data-testid='assistant-message'],[data-is-streaming]")
    ) return "assistant";

    const signal = `${textFromHeadings(turn)} ${turn.getAttribute("aria-label") || ""}`;
    if (/^you said:/i.test(signal) || /\byou said:/i.test(signal)) return "user";
    if (/^claude responded:/i.test(signal) || /\bclaude responded:/i.test(signal)) return "assistant";
    return "unknown";
  }

  function findMessageNode(turn, role) {
    const selectors = role === "user"
      ? ["[data-testid='user-message']", ".font-user-message", "[data-message-author-role='user']"]
      : [
          "[data-testid='assistant-message'] .standard-markdown",
          "[data-testid='assistant-message'] .prose",
          "[data-testid='assistant-message']",
          ".font-claude-response .standard-markdown",
          ".font-claude-response",
          ".standard-markdown",
          ".prose"
        ];
    for (const selector of selectors) {
      const node = turn.matches(selector) ? turn : turn.querySelector(selector);
      if (node && core.normalizeText(node.innerText)) return node;
    }
    return turn;
  }

  function getProviderMessageId(turn) {
    return turn.getAttribute("data-message-id") || null;
  }

  adapter.start({
    provider: "claude",
    turnSelector,
    detectRole,
    findMessageNode,
    getProviderMessageId,
    getMessageTimestamp(turn) {
      return turn.querySelector("time[datetime]")?.getAttribute("datetime") || null;
    },
    getPageIdentity() {
      return document.querySelector("[aria-label^='Chat messages']")?.getAttribute("aria-label") || "";
    },
    getTemporarySignal() {
      return document.querySelector("[aria-label*='Incognito' i],[data-testid*='incognito' i]")?.textContent || "";
    },
    getTitle() {
      return document.title.replace(/\s*[|—-]\s*Claude\s*$/i, "").trim() || "Claude conversation";
    }
  });
})();
