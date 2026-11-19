(() => {
  "use strict";

  const PROVIDERS = Object.freeze({
    chatgpt: Object.freeze({
      providerFamily: "openai",
      product: "chatgpt",
      surface: "web",
      hosts: Object.freeze(["chatgpt.com", "chat.openai.com"])
    }),
    claude: Object.freeze({
      providerFamily: "anthropic",
      product: "claude",
      surface: "web",
      hosts: Object.freeze(["claude.ai"])
    }),
    gemini: Object.freeze({
      providerFamily: "google",
      product: "gemini",
      surface: "web",
      hosts: Object.freeze(["gemini.google.com"])
    })
  });

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function fnv1a(value) {
    const text = String(value ?? "");
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function isSupportedChatGptUrl(value) {
    return isSupportedProviderUrl("chatgpt", value);
  }

  function isSupportedProviderUrl(provider, value) {
    try {
      return PROVIDERS[provider]?.hosts.includes(new URL(value).hostname) || false;
    } catch {
      return false;
    }
  }

  function providerDefinition(provider) {
    return PROVIDERS[provider] || null;
  }

  function providerDefinitionForUrl(value) {
    return Object.values(PROVIDERS).find((definition) => isSupportedProviderUrl(definition.product, value)) || null;
  }

  function parseConversationIdFromUrl(value, provider = "chatgpt") {
    try {
      const url = new URL(value);
      const definition = providerDefinition(provider) || providerDefinitionForUrl(value);
      const product = definition?.product || provider;

      const pathPattern = product === "claude"
        ? /\/chat\/([^/?#]+)/i
        : product === "gemini"
          ? /\/app\/([^/?#]+)/i
          : /\/c\/([^/?#]+)/i;
      const pathMatch = url.pathname.match(pathPattern);
      if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);

      const shareMatch = url.pathname.match(/\/share\/([^/?#]+)/i);
      if (shareMatch?.[1]) return `share:${shareMatch[1]}`;
    } catch {
      return null;
    }

    return null;
  }

  function parseConversationId(value, ariaLabel = "", provider = "chatgpt") {
    const urlId = parseConversationIdFromUrl(value, provider);
    if (urlId) return urlId;

    const labelMatch = String(ariaLabel).match(/\bConversation\s+([^\s]+)/i);
    return labelMatch?.[1] ?? null;
  }

  function isProvisionalConversationId(value) {
    return /^(?:pending:|web:|local-(?:chatgpt|claude|gemini):)/i.test(normalizeText(value));
  }

  function isTransientAssistantStatus(role, text) {
    if (role !== "assistant") return false;
    return /^(?:(?:chatgpt|claude|gemini)\s+said:\s*)?thinking(?:\.{3}|…)?$/i.test(normalizeText(text));
  }

  function isLikelyTemporaryChat(value, pageText = "") {
    let urlSignal = false;
    try {
      const url = new URL(value);
      const combined = `${url.pathname} ${url.search}`.toLowerCase();
      urlSignal = /temporary|temp-chat|temporary-chat/.test(combined);
    } catch {
      urlSignal = false;
    }

    const textSignal = /\btemporary chat\b/i.test(String(pageText));
    return urlSignal || textSignal;
  }

  function createEventId(input) {
    const product = normalizeText(input.product || input.provider) || "chatgpt";
    const providerMessageId = normalizeText(input.providerMessageId) || null;
    const sequence = Number.isFinite(input.sequence) ? input.sequence : 0;
    const messageKey = providerMessageId || `sequence:${sequence}:${input.role || "unknown"}`;
    const conversationId = input.conversationId || `pending:${fnv1a(input.url || input.title || "chatgpt")}`;
    const stableIdentity = [product, conversationId, messageKey].join("|");
    return `evt_${fnv1a(stableIdentity)}`;
  }

  function browserTitle(provider, value) {
    const brand = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" }[provider] || provider;
    const title = normalizeText(value).replace(new RegExp(`\\s*[|—-]\\s*${brand}\\s*$`, "i"), "").trim();
    const generic = !title || /^(?:chatgpt|claude|gemini|google gemini|new chat|new conversation|untitled|(?:chatgpt|claude|gemini) conversation)$/i.test(title);
    return { title: title || `${brand} conversation`, titleBasis: generic ? "generic" : "source" };
  }

  function browserSourceMetadata(input) {
    return {
      version: 1,
      titleBasis: input.titleBasis || "unknown",
      conversationIdentity: input.canonicalConversationId ? "provider" : "local",
      messageIdentity: input.messageIdentity || (input.providerMessageId ? "provider" : "local"),
      timestampBasis: input.messageTimestamp ? "source" : "observed",
      linksStatus: "inspected",
      attachmentsStatus: input.captureAttachments ? "inspected" : "not_inspected"
    };
  }

  function createCapturedEvent(input) {
    const product = normalizeText(input.product || input.provider) || "chatgpt";
    const definition = providerDefinition(product) || PROVIDERS.chatgpt;
    const text = normalizeText(input.text);
    const providerMessageId = normalizeText(input.providerMessageId) || null;
    const sequence = Number.isFinite(input.sequence) ? input.sequence : 0;
    const conversationId = input.conversationId || `pending:${fnv1a(input.url || input.title || "chatgpt")}`;

    return {
      eventId: createEventId({ ...input, conversationId, providerMessageId, sequence }),
      provider: product,
      providerFamily: input.providerFamily || definition.providerFamily,
      product,
      surface: input.surface || definition.surface,
      conversationId,
      providerMessageId,
      sequence,
      role: input.role || "unknown",
      text,
      contentHash: fnv1a(text),
      sourceUrl: input.url,
      sourceLocator: normalizeText(input.sourceLocator) || `web:${product}:${conversationId}`,
      chatTitle: normalizeText(input.title) || `Untitled ${product} conversation`,
      messageTimestamp: input.messageTimestamp || null,
      capturedAt: input.capturedAt || new Date().toISOString(),
      links: Array.isArray(input.links) ? [...new Set(input.links.filter(Boolean))] : [],
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      ...(input.sourceMetadata ? { sourceMetadata: { ...input.sourceMetadata } } : {})
    };
  }

  function rekeyCapturedEvents(events, fromConversationId, toConversationId, sourceUrl = null) {
    if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) {
      return { events: [...events], migrated: 0, merged: 0 };
    }

    const byId = new Map();
    let migrated = 0;
    let merged = 0;

    for (const event of events) {
      const shouldMigrate = event.conversationId === fromConversationId;
      const next = shouldMigrate
        ? {
            ...event,
            conversationId: toConversationId,
            eventId: createEventId({ ...event, conversationId: toConversationId }),
            sourceUrl: sourceUrl || event.sourceUrl
          }
        : event;

      if (shouldMigrate) migrated += 1;
      const existing = byId.get(next.eventId);
      if (!existing) {
        byId.set(next.eventId, next);
        continue;
      }

      merged += 1;
      const newest = (existing.capturedAt || "") >= (next.capturedAt || "") ? existing : next;
      const firstCapturedAt = [
        existing.firstCapturedAt || existing.capturedAt,
        next.firstCapturedAt || next.capturedAt
      ].filter(Boolean).sort()[0];
      byId.set(next.eventId, { ...newest, ...(firstCapturedAt ? { firstCapturedAt } : {}) });
    }

    return { events: [...byId.values()], migrated, merged };
  }

  function eventFingerprint(event) {
    const messageKey = normalizeText(event.providerMessageId)
      || `sequence:${Number.isFinite(event.sequence) ? event.sequence : 0}`;
    return [event.role || "unknown", messageKey, event.contentHash || fnv1a(event.text)].join("|");
  }

  function reconcileProvisionalAliases(storedEvents, incomingEvents) {
    let reconciledEvents = [...storedEvents];
    const aliases = [];
    let migrated = 0;
    let merged = 0;
    const canonicalGroups = new Map();

    for (const event of incomingEvents) {
      if (!event.conversationId || isProvisionalConversationId(event.conversationId)) continue;
      const fingerprints = canonicalGroups.get(event.conversationId) || new Set();
      fingerprints.add(eventFingerprint(event));
      canonicalGroups.set(event.conversationId, fingerprints);
    }

    const provisionalIds = [...new Set(
      storedEvents
        .map((event) => event.conversationId)
        .filter((conversationId) => isProvisionalConversationId(conversationId))
    )];

    for (const provisionalId of provisionalIds) {
      const provisionalFingerprints = new Set(
        reconciledEvents
          .filter((event) => event.conversationId === provisionalId)
          .map(eventFingerprint)
      );
      const candidates = [...canonicalGroups.entries()]
        .map(([conversationId, fingerprints]) => ({
          conversationId,
          matches: [...provisionalFingerprints].filter((value) => fingerprints.has(value)).length
        }))
        .filter((candidate) => candidate.matches > 0)
        .sort((left, right) => right.matches - left.matches);

      if (!candidates.length || (candidates[1] && candidates[0].matches === candidates[1].matches)) continue;
      const canonicalId = candidates[0].conversationId;
      const canonicalUrl = incomingEvents.find(
        (event) => event.conversationId === canonicalId
      )?.sourceUrl;
      const result = rekeyCapturedEvents(reconciledEvents, provisionalId, canonicalId, canonicalUrl);
      reconciledEvents = result.events;
      migrated += result.migrated;
      merged += result.merged;
      aliases.push({ fromConversationId: provisionalId, toConversationId: canonicalId });
    }

    return { events: reconciledEvents, aliases, migrated, merged };
  }

  function reconcileFallbackEventIdentities(storedEvents, incomingEvents) {
    const byId = new Map(storedEvents.map((event) => [event.eventId, event]));
    const migrations = [];

    for (const incoming of incomingEvents) {
      if (incoming.providerMessageId || byId.has(incoming.eventId)) continue;
      const candidates = [...byId.values()].filter((stored) => (
        stored.eventId !== incoming.eventId
        && stored.provider === incoming.provider
        && stored.conversationId === incoming.conversationId
        && stored.sequence === incoming.sequence
        && stored.role === incoming.role
        && isLikelyLiveRevision(stored, incoming)
      ));
      if (candidates.length !== 1) continue;

      const previous = candidates[0];
      byId.delete(previous.eventId);
      byId.set(incoming.eventId, {
        ...incoming,
        firstCapturedAt: previous.firstCapturedAt || previous.capturedAt
      });
      migrations.push({ fromEventId: previous.eventId, toEventId: incoming.eventId });
    }

    return { events: [...byId.values()], migrations };
  }

  function isLikelyLiveRevision(stored, incoming) {
    const oldText = normalizeText(stored.text);
    const newText = normalizeText(incoming.text);
    return oldText === newText || (
      oldText.length >= 32
      && newText.startsWith(oldText)
      && Math.abs(Date.parse(stored.capturedAt || "") - Date.parse(incoming.capturedAt || "")) <= 5 * 60 * 1000
    );
  }

  function disambiguateFallbackCollisions(storedEvents, incomingEvents) {
    return incomingEvents.map((incoming) => {
      if (incoming.providerMessageId) return incoming;
      const previous = storedEvents.find((stored) => stored.eventId === incoming.eventId);
      if (!previous || isLikelyLiveRevision(previous, incoming)) return incoming;
      return {
        ...incoming,
        eventId: `evt_${fnv1a([incoming.eventId, incoming.role, incoming.contentHash].join("|"))}`
      };
    });
  }


  globalThis.SharedMemoryCaptureCore = Object.freeze({
    PROVIDERS,
    browserTitle,
    browserSourceMetadata,
    createCapturedEvent,
    createEventId,
    fnv1a,
    isLikelyTemporaryChat,
    isProvisionalConversationId,
    isSupportedChatGptUrl,
    isSupportedProviderUrl,
    isTransientAssistantStatus,
    normalizeText,
    parseConversationId,
    parseConversationIdFromUrl,
    providerDefinition,
    providerDefinitionForUrl,
    reconcileProvisionalAliases,
    reconcileFallbackEventIdentities,
    disambiguateFallbackCollisions,
    rekeyCapturedEvents
  });
})();
