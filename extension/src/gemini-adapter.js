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

  function messageSelectors(role) {
    return role === "user"
      ? [".query-text", ".user-query-bubble-container", "[data-test-id='user-query-text']"]
      : [
          ".model-response-text",
          "message-content",
          ".markdown",
          ".response-content",
          "[data-test-id='model-response-text']"
        ];
  }

  function findMessageNode(turn, role) {
    for (const selector of messageSelectors(role)) {
      const node = turn.querySelector(selector);
      // Gemini leaves older message bodies loaded under content-visibility:auto.
      // Firefox can return empty innerText there, despite the message being present.
      if (node && core.normalizeText(node.textContent)) return node;
    }
    return null;
  }

  function isHidden(node, style) {
    return node.hasAttribute("hidden")
      || node.hasAttribute("inert")
      // Gemini can mark its entire visible application shell aria-hidden.
      // That accessibility flag does not hide the recognized message bodies.
      // Keep rejecting hidden flags inside messages and actual hidden/inert shells.
      || (node.tagName.toLowerCase() !== "chat-app-orchestrator" && node.getAttribute("aria-hidden") === "true")
      || style.display === "none"
      || style.visibility === "hidden"
      || style.visibility === "collapse"
      || style.contentVisibility === "hidden";
  }

  function readLoadedMessageText(node) {
    // Only traverse a recognized message body. Never read the surrounding turn,
    // where Gemini keeps buttons and other interface text.
    function read(part) {
      if (part.nodeType === 3) return part.textContent || "";
      if (part.nodeType !== 1) return "";
      const tag = part.tagName.toLowerCase();
      if (["button", "script", "style", "svg", "textarea", "input", "select", "template", "noscript"].includes(tag)
        || isHidden(part, getComputedStyle(part))) return "";
      if (tag === "br") return "\n";
      const children = [...part.childNodes].map(read).join("");
      return ["p", "div", "section", "article", "li", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]
        .includes(tag) ? `${children}\n` : children;
    }
    return read(node).trim();
  }

  function extractText(messageNode, turn) {
    // Never fall back to the whole response wrapper: it also contains controls.
    if (messageNode === turn) return "";
    if (detectRole(turn) === "user") {
      // Gemini's query-text also contains an accessibility heading repeating the
      // entire prompt. Its actual paragraphs are separate from that label.
      const lines = [...messageNode.querySelectorAll(".query-text-line")];
      if (lines.length) return lines.map(readMessageText).join("\n");
    }
    return readMessageText(messageNode);
  }

  function readMessageText(messageNode) {
    const skippedAncestors = [];
    for (let node = messageNode; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (isHidden(node, style)) return "";
      if (style.contentVisibility === "auto") skippedAncestors.push(node);
    }

    let rendered = "";
    try { rendered = messageNode.innerText; } catch { /* Try the loaded body below. */ }
    if (core.normalizeText(rendered)) return rendered;

    // Prefer the same rendered text as an on-screen message. If Firefox still
    // reports an empty body, traverse only the known message body and exclude
    // hidden descendants and controls. Restore styles before returning.
    if (skippedAncestors.length) {
      const restored = [];
      try {
        for (const node of skippedAncestors.reverse()) {
          restored.push({
            node,
            value: node.style.getPropertyValue("content-visibility"),
            priority: node.style.getPropertyPriority("content-visibility"),
            hadStyle: node.hasAttribute("style")
          });
          node.style.setProperty("content-visibility", "visible", "important");
        }
        for (let node = messageNode; node; node = node.parentElement) {
          if (isHidden(node, getComputedStyle(node))) return "";
        }
        try { rendered = messageNode.innerText; } catch { /* Try the loaded body below. */ }
      } finally {
        for (const { node, value, priority, hadStyle } of restored.reverse()) {
          if (value) node.style.setProperty("content-visibility", value, priority);
          else node.style.removeProperty("content-visibility");
          if (!hadStyle && !node.getAttribute("style")) node.removeAttribute("style");
        }
      }
    }
    return core.normalizeText(rendered) ? rendered : readLoadedMessageText(messageNode);
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
    extractText,
    getProviderMessageId,
    diagnoseTurn(turn, role) {
      return messageSelectors(role).map((selector) => {
        const node = turn.querySelector(selector);
        return {
          selector,
          present: Boolean(node),
          renderedCharacters: core.normalizeText(node?.innerText).length,
          loadedCharacters: core.normalizeText(node?.textContent).length
        };
      });
    },
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
