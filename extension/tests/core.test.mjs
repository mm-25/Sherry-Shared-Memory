import test from "node:test";
import assert from "node:assert/strict";
import "../src/core.js";

const core = globalThis.SharedMemoryCaptureCore;

test("normalizes whitespace without changing words", () => {
  assert.equal(core.normalizeText("  hello\n\tworld  "), "hello world");
});

test("recognizes supported ChatGPT hosts only", () => {
  assert.equal(core.isSupportedChatGptUrl("https://chatgpt.com/c/abc"), true);
  assert.equal(core.isSupportedChatGptUrl("https://chat.openai.com/c/abc"), true);
  assert.equal(core.isSupportedChatGptUrl("https://example.com/c/abc"), false);
});

test("maps supported browser providers to a shared capture definition", () => {
  assert.equal(core.providerDefinitionForUrl("https://claude.ai/chat/test").product, "claude");
  assert.equal(core.providerDefinitionForUrl("https://gemini.google.com/app/test").providerFamily, "google");
  assert.equal(core.isSupportedProviderUrl("claude", "https://chatgpt.com/c/abc"), false);
});

test("extracts conversation identifiers from current and shared URL shapes", () => {
  assert.equal(core.parseConversationId("https://chatgpt.com/c/conversation-123"), "conversation-123");
  assert.equal(core.parseConversationId("https://chatgpt.com/g/gpt-name/c/conversation-456"), "conversation-456");
  assert.equal(core.parseConversationId("https://chatgpt.com/share/share-789"), "share:share-789");
});

test("extracts Claude and Gemini conversation identifiers", () => {
  assert.equal(
    core.parseConversationIdFromUrl("https://claude.ai/chat/0b583ff7-4aa1-403d-a6c7-658b0e0af315", "claude"),
    "0b583ff7-4aa1-403d-a6c7-658b0e0af315"
  );
  assert.equal(
    core.parseConversationIdFromUrl("https://gemini.google.com/app/conversation-789", "gemini"),
    "conversation-789"
  );
  assert.equal(core.parseConversationIdFromUrl("https://claude.ai/new", "claude"), null);
});

test("falls back to the accessible conversation label", () => {
  assert.equal(core.parseConversationId("https://chatgpt.com/", "Conversation chat-757eb17a"), "chat-757eb17a");
});

test("distinguishes canonical URL IDs from provisional page IDs", () => {
  assert.equal(core.parseConversationIdFromUrl("https://chatgpt.com/c/chat-123"), "chat-123");
  assert.equal(core.parseConversationIdFromUrl("https://chatgpt.com/"), null);
  assert.equal(core.isProvisionalConversationId("WEB:temporary-123"), true);
  assert.equal(core.isProvisionalConversationId("pending:abc123"), true);
  assert.equal(core.isProvisionalConversationId("chat-123"), false);
});

test("filters only transient assistant thinking labels", () => {
  assert.equal(core.isTransientAssistantStatus("assistant", "Thinking"), true);
  assert.equal(core.isTransientAssistantStatus("assistant", "Thinking…"), true);
  assert.equal(core.isTransientAssistantStatus("assistant", "Thinking..."), true);
  assert.equal(core.isTransientAssistantStatus("assistant", "ChatGPT said: Thinking"), true);
  assert.equal(core.isTransientAssistantStatus("assistant", "Claude said: Thinking…"), true);
  assert.equal(core.isTransientAssistantStatus("user", "Thinking"), false);
  assert.equal(core.isTransientAssistantStatus("assistant", "Thinking through the answer"), false);
});

test("keeps event identity stable while streamed content changes", () => {
  const first = core.createCapturedEvent({
    conversationId: "chat-1",
    providerMessageId: "turn-2",
    sequence: 2,
    role: "assistant",
    text: "A partial answer",
    url: "https://chatgpt.com/c/chat-1",
    title: "Test",
    capturedAt: "2026-09-13T00:00:00.000Z"
  });
  const completed = core.createCapturedEvent({
    ...first,
    text: "A partial answer that is now complete"
  });

  assert.equal(first.eventId, completed.eventId);
  assert.notEqual(first.contentHash, completed.contentHash);
});

test("keeps provider identity and source provenance on normalized events", () => {
  const event = core.createCapturedEvent({
    provider: "claude",
    conversationId: "chat-claude-1",
    providerMessageId: "message-1",
    sequence: 0,
    role: "user",
    text: "Hello Claude",
    url: "https://claude.ai/chat/chat-claude-1",
    title: "Claude test"
  });
  assert.equal(event.providerFamily, "anthropic");
  assert.equal(event.product, "claude");
  assert.equal(event.surface, "web");
  assert.equal(event.sourceLocator, "web:claude:chat-claude-1");
});

test("creates a deterministic fallback identity when message IDs are missing", () => {
  const input = {
    conversationId: "chat-1",
    sequence: 3,
    role: "user",
    text: "Remember this",
    url: "https://chatgpt.com/c/chat-1",
    title: "Test"
  };
  assert.equal(core.createCapturedEvent(input).eventId, core.createCapturedEvent(input).eventId);
});

test("rekeys provisional events to their canonical conversation without duplicates", () => {
  const provisional = core.createCapturedEvent({
    conversationId: "WEB:temporary-123",
    providerMessageId: "conversation-turn-0",
    sequence: 0,
    role: "user",
    text: "First message",
    url: "https://chatgpt.com/",
    capturedAt: "2026-09-13T19:00:00.000Z"
  });
  const canonical = core.createCapturedEvent({
    conversationId: "chat-123",
    providerMessageId: "conversation-turn-0",
    sequence: 0,
    role: "user",
    text: "First message",
    url: "https://chatgpt.com/c/chat-123",
    capturedAt: "2026-09-13T19:00:01.000Z"
  });

  const migrated = core.rekeyCapturedEvents(
    [provisional, canonical],
    "WEB:temporary-123",
    "chat-123",
    "https://chatgpt.com/c/chat-123"
  );

  assert.equal(migrated.migrated, 1);
  assert.equal(migrated.merged, 1);
  assert.equal(migrated.events.length, 1);
  assert.equal(migrated.events[0].eventId, canonical.eventId);
  assert.equal(migrated.events[0].conversationId, "chat-123");
  assert.equal(migrated.events[0].sourceUrl, "https://chatgpt.com/c/chat-123");
});

test("repairs a provisional alias after an extension or browser restart", () => {
  const provisional = core.createCapturedEvent({
    conversationId: "WEB:temporary-123",
    providerMessageId: "conversation-turn-0",
    sequence: 0,
    role: "user",
    text: "First message",
    url: "https://chatgpt.com/c/WEB:temporary-123"
  });
  const canonical = core.createCapturedEvent({
    conversationId: "chat-123",
    providerMessageId: "conversation-turn-0",
    sequence: 0,
    role: "user",
    text: "First message",
    url: "https://chatgpt.com/c/chat-123"
  });

  const result = core.reconcileProvisionalAliases([provisional], [canonical]);

  assert.deepEqual(result.aliases, [{
    fromConversationId: "WEB:temporary-123",
    toConversationId: "chat-123"
  }]);
  assert.equal(result.migrated, 1);
  assert.equal(result.events[0].eventId, canonical.eventId);
  assert.equal(result.events[0].conversationId, "chat-123");
});

test("does not repair an ambiguous provisional alias", () => {
  const provisional = core.createCapturedEvent({
    conversationId: "WEB:temporary-123",
    providerMessageId: "conversation-turn-0",
    sequence: 0,
    role: "user",
    text: "Hello"
  });
  const firstCanonical = core.createCapturedEvent({
    conversationId: "chat-123",
    providerMessageId: "conversation-turn-0",
    sequence: 0,
    role: "user",
    text: "Hello"
  });
  const secondCanonical = core.createCapturedEvent({
    conversationId: "chat-456",
    providerMessageId: "conversation-turn-0",
    sequence: 0,
    role: "user",
    text: "Hello"
  });

  const result = core.reconcileProvisionalAliases(
    [provisional],
    [firstCanonical, secondCanonical]
  );

  assert.equal(result.aliases.length, 0);
  assert.equal(result.events[0].conversationId, "WEB:temporary-123");
});

test("migrates one unstable browser message identity to the stable sequence fallback", () => {
  const previous = core.createCapturedEvent({
    provider: "claude",
    conversationId: "claude-1",
    providerMessageId: "TurnStatus",
    sequence: 1,
    role: "assistant",
    text: "Complete answer",
    url: "https://claude.ai/chat/claude-1",
    title: "Test"
  });
  const replacement = core.createCapturedEvent({
    provider: "claude",
    conversationId: "claude-1",
    sequence: 1,
    role: "assistant",
    text: "Complete answer",
    url: "https://claude.ai/chat/claude-1",
    title: "Test"
  });

  const result = core.reconcileFallbackEventIdentities([previous], [replacement]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].eventId, replacement.eventId);
  assert.deepEqual(result.migrations, [{ fromEventId: previous.eventId, toEventId: replacement.eventId }]);
});

test("does not migrate an ambiguous fallback identity", () => {
  const incoming = core.createCapturedEvent({
    provider: "claude",
    conversationId: "claude-1",
    sequence: 1,
    role: "assistant",
    text: "Current branch",
    url: "https://claude.ai/chat/claude-1",
    title: "Test"
  });
  const prior = ["first", "second"].map((providerMessageId) => core.createCapturedEvent({
    ...incoming,
    providerMessageId
  }));

  const result = core.reconcileFallbackEventIdentities(prior, [incoming]);
  assert.equal(result.events.length, 2);
  assert.equal(result.migrations.length, 0);
});

test("a shifted position cannot overwrite a different old message", () => {
  const previous = core.createCapturedEvent({ provider: "gemini", conversationId: "chat-1", sequence: 14, role: "assistant", text: "This is the old answer about an entirely different project with enough detail to distinguish it.", capturedAt: "2026-09-24T12:00:00Z", url: "https://gemini.google.com/app/chat-1" });
  const incoming = core.createCapturedEvent({ provider: "gemini", conversationId: "chat-1", sequence: 14, role: "assistant", text: "This is the new answer about something else altogether, shown in the same position later.", capturedAt: "2026-09-27T12:00:00Z", url: "https://gemini.google.com/app/chat-1" });
  const [separate] = core.disambiguateFallbackCollisions([previous], [incoming]);
  assert.notEqual(separate.eventId, previous.eventId);
  const result = core.reconcileFallbackEventIdentities([previous], [separate]);
  assert.equal(result.migrations.length, 0);
  assert.equal(result.events[0].text, previous.text);
});


test("detects temporary-chat signals without treating normal URLs as temporary", () => {
  assert.equal(core.isLikelyTemporaryChat("https://chatgpt.com/?temporary-chat=true"), true);
  assert.equal(core.isLikelyTemporaryChat("https://chatgpt.com/c/chat-1"), false);
  assert.equal(core.isLikelyTemporaryChat("https://chatgpt.com/", "Temporary Chat"), true);
});

test("provider-local conversation labels are provisional during legacy recovery", () => {
  assert.equal(core.isProvisionalConversationId("local-chatgpt:invented-id"),true);
  assert.equal(core.isProvisionalConversationId("local-gemini:invented-id"),true);
  assert.equal(core.isProvisionalConversationId("6add1d41-b140-83ea-81d1-718bdfe96072"),false);
});
