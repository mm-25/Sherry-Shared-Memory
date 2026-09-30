(() => {
  "use strict";

  function compact(value) {
    return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function timestamp(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function attachmentMetadata(message) {
    const items = [...(Array.isArray(message.attachments) ? message.attachments : []),
      ...(Array.isArray(message.files) ? message.files : [])];
    const seen = new Set();
    return items.filter((item) => {
      const name = String(item?.file_name || item?.name || item?.filename || "").trim();
      const identity = name.toLowerCase() || String(item?.file_uuid || "").trim();
      if (!identity || seen.has(identity)) return false;
      seen.add(identity);
      return true;
    }).slice(0, 25).map((item) => ({
      name: String(item.file_name || item.name || item.filename || "Attachment").slice(0, 500),
      type: String(item.file_type || item.mime_type || "unknown").slice(0, 200),
      size: Number.isFinite(Number(item.file_size)) ? Number(item.file_size) : null,
      sourceOnly: true
    }));
  }

  function normalize(data) {
    const records = Array.isArray(data) ? data : data?.conversations;
    if (!Array.isArray(records)) throw new Error("Choose Claude's conversations.json export.");
    const stats = { rawMessages: 0, textMessages: 0, nonTextMessages: 0, nonTextConversations: 0, attachmentReferences: 0, summaries: 0, invalidIds: 0 };
    const conversations = [];
    for (const record of records) {
      const id = String(record?.uuid || "").trim();
      if (!id || !Array.isArray(record.chat_messages)) {
        stats.invalidIds += 1;
        continue;
      }
      const messages = [];
      if (record.summary) stats.summaries += 1;
      record.chat_messages.forEach((message, sourceIndex) => {
        stats.rawMessages += 1;
        const messageId = String(message?.uuid || "").trim();
        const role = message?.sender === "human" ? "user" : message?.sender === "assistant" ? "assistant" : null;
        const text = (Array.isArray(message?.content) ? message.content : [])
          .filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim())
          .map((block) => block.text.trim()).join("\n\n").slice(0, 250_000);
        if (!messageId || !role) {
          stats.invalidIds += 1;
          return;
        }
        if (!text) {
          stats.nonTextMessages += 1;
          return;
        }
        const attachments = attachmentMetadata(message);
        stats.attachmentReferences += attachments.length;
        stats.textMessages += 1;
        messages.push({ id: messageId, role, text, timestamp: timestamp(message.created_at || message.updated_at), sequence: sourceIndex, attachments });
      });
      if (messages.length) conversations.push({
        id,
        title: String(record.name || "Untitled Claude conversation").slice(0, 1000),
        sourceUrl: `https://claude.ai/chat/${encodeURIComponent(id)}`,
        messages
      });
      else stats.nonTextConversations += 1;
    }
    return { conversations, stats };
  }

  function conversationIdFromUrl(value) {
    try {
      return new URL(value).pathname.match(/^\/chat\/([^/]+)/)?.[1] || null;
    } catch {
      return null;
    }
  }

  function matchConversation(record, existing) {
    return existing.filter((item) => item.provider === "claude" && (
      item.provider_conversation_id === record.id || conversationIdFromUrl(item.canonical_chat_url) === record.id
    ));
  }

  function possibleUnidentifiedOverlap(record, existing) {
    const title = compact(record.title).toLowerCase();
    return title && existing.some((item) => item.provider === "claude"
      && compact(item.title).toLowerCase() === title
      && !conversationIdFromUrl(item.canonical_chat_url)
      && (!item.provider_conversation_id || String(item.provider_conversation_id).startsWith("pending:")));
  }

  function possibleContentOverlap(record, events) {
    const source = record.messages.map((message) => `${message.role}|${compact(message.text)}`);
    let matches = 0;
    for (const event of events) {
      const text = compact(event.text_content);
      if (text.length < 40) continue;
      if (source.includes(`${event.role}|${text}`)) {
        if (text.length >= 100) return true;
        matches += 1;
        if (matches >= 2) return true;
      }
    }
    return false;
  }

  function classifyMessage(message, existingEvents) {
    const byId = existingEvents.filter((event) => event.provider_message_id === message.id);
    if (byId.length > 1) return "ambiguous";
    if (byId.length === 1) {
      return byId[0].role === message.role && compact(byId[0].text_content) === compact(message.text)
        ? "duplicate" : "ambiguous";
    }
    const sameText = existingEvents.filter((event) => event.role === message.role
      && compact(event.text_content) === compact(message.text));
    if (sameText.length === 1) {
      const sourceTime = Date.parse(message.timestamp || "");
      const eventTime = Date.parse(sameText[0].message_timestamp || "");
      return Number.isFinite(sourceTime) && Number.isFinite(eventTime)
        && Math.abs(sourceTime - eventTime) < 60_000 ? "duplicate" : "ambiguous";
    }
    if (sameText.length > 1) return "ambiguous";
    const prefix = compact(message.text).slice(0, 100);
    const possibleTruncation = prefix.length >= 40 && existingEvents.some((event) => {
      if (event.role !== message.role) return false;
      const current = compact(event.text_content);
      return current.startsWith(prefix) || (current.length >= 40 && compact(message.text).startsWith(current.slice(0, 100)));
    });
    if (possibleTruncation) return "ambiguous";
    const sourceTime = Date.parse(message.timestamp || "");
    if (Number.isFinite(sourceTime) && existingEvents.some((event) => {
      const eventTime = Date.parse(event.message_timestamp || "");
      return event.role === message.role && Number.isFinite(eventTime)
        && Math.abs(eventTime - sourceTime) < 60_000;
    })) return "ambiguous";
    return "new";
  }

  globalThis.SherryClaudeImport = Object.freeze({ normalize, matchConversation, possibleUnidentifiedOverlap, possibleContentOverlap, classifyMessage, compact });
})();
