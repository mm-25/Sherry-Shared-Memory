const CAPTURE_SCRIPTS = {
  "chatgpt.com": ["/src/core.js", "/src/chatgpt-adapter.js"],
  "chat.openai.com": ["/src/core.js", "/src/chatgpt-adapter.js"],
  "claude.ai": ["/src/core.js", "/src/web-provider-adapter.js", "/src/claude-adapter.js"],
  "gemini.google.com": ["/src/core.js", "/src/web-provider-adapter.js", "/src/gemini-adapter.js"],
  "shared-memory-ingestion.mufaddal-m25.workers.dev": ["/src/sherry-bridge.js"]
};

export function scriptsForOpenTab(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? CAPTURE_SCRIPTS[parsed.hostname.toLowerCase()] || null : null;
  } catch {
    return null;
  }
}

export async function restoreOpenTabs(extensionApi) {
  if (!extensionApi.scripting?.executeScript) return { restored: 0, failed: 0 };
  const tabs = await extensionApi.tabs.query({});
  let restored = 0;
  let failed = 0;
  for (const tab of tabs) {
    if (!tab.id || !scriptsForOpenTab(tab.url)) continue;
    try {
      await restoreTab(extensionApi, tab);
      restored += 1;
    } catch {
      // A tab can close or lose site access during recovery. Other tabs still recover.
      failed += 1;
    }
  }
  return { restored, failed };
}

export async function restoreTab(extensionApi, tab) {
  const files = scriptsForOpenTab(tab?.url);
  if (!tab?.id || !files || !extensionApi.scripting?.executeScript) return false;
  try {
    const state = await extensionApi.tabs.sendMessage(tab.id, { type: "GET_CAPTURE_STATE" });
    if (state?.ok) {
      await extensionApi.tabs.sendMessage(tab.id, { type: "RESUME_CAPTURE" });
      return true;
    }
  } catch {
    // Missing content script: recover through normal tab events, without a popup.
  }
  await extensionApi.scripting.executeScript({ target: { tabId: tab.id }, files });
  return true;
}
