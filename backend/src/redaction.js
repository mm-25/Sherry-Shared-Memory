import { redactText } from "../../web/text-redaction.js";
export { redactText };

const SENSITIVE_QUERY_KEYS = /^(?:access_token|api[_-]?key|auth|code|credential|key|password|refresh_token|secret|token)$/i;

function increment(counts, type, amount = 1) {
  counts[type] = (counts[type] || 0) + amount;
}

export function redactUrl(value) {
  if (value == null) return { value: null, count: 0 };
  const url = new URL(value);
  let count = 0;
  if (url.password) {
    url.password = "[REDACTED]";
    count += 1;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (!SENSITIVE_QUERY_KEYS.test(key)) continue;
    url.searchParams.set(key, "[REDACTED]");
    count += 1;
  }
  if (url.hash.includes("=")) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    for (const key of [...fragment.keys()]) {
      if (!SENSITIVE_QUERY_KEYS.test(key)) continue;
      fragment.set(key, "[REDACTED]");
      count += 1;
    }
    if (count) url.hash = fragment.toString();
  }
  return { value: url.toString(), count };
}

export function redactCaptureBatch(batch) {
  const totals = {};
  const perEvent = [];
  const events = batch.events.map((event) => {
    const text = redactText(event.text);
    const title = redactText(event.chatTitle);
    const sourceUrl = redactUrl(event.sourceUrl);
    const links = event.links.map(redactUrl);
    const sourceLocator = event.sourceLocator == null ? { value: null, count: 0 }
      : /^https:\/\//i.test(event.sourceLocator)
      ? redactUrl(event.sourceLocator)
      : redactText(event.sourceLocator);
    const attachments = event.attachments.map((attachment) => {
      const name = redactText(String(attachment.name || "").slice(0, 500));
      const type = redactText(String(attachment.type || "").slice(0, 200));
      const kind = redactText(String(attachment.kind || "").slice(0, 100));
      let url = { value: null, count: 0 };
      if (typeof attachment.url === "string" && attachment.url.length <= 4096) {
        try {
          if (new URL(attachment.url).protocol === "https:") url = redactUrl(attachment.url);
        } catch { /* Invalid or inline attachment URLs are not stored. */ }
      }
      const counts = {};
      for (const item of [name, type, kind]) {
        for (const [category, count] of Object.entries(item.counts)) increment(counts, category, count);
      }
      if (url.count) increment(counts, "url_secret", url.count);
      return {
        kind: kind.value || null,
        name: name.value || null,
        type: type.value || null,
        size: Number.isFinite(attachment.size) && attachment.size >= 0 ? attachment.size : null,
        sourceOnly: attachment.sourceOnly === true,
        url: url.value,
        counts
      };
    });
    const eventCounts = { ...text.counts };

    for (const [type, count] of Object.entries(title.counts)) increment(eventCounts, type, count);
    if (sourceUrl.count) increment(eventCounts, "url_secret", sourceUrl.count);
    if (sourceLocator.count) increment(eventCounts, "url_secret", sourceLocator.count);
    for (const [type, count] of Object.entries(sourceLocator.counts || {})) increment(eventCounts, type, count);
    const linkSecretCount = links.reduce((sum, item) => sum + item.count, 0);
    if (linkSecretCount) increment(eventCounts, "url_secret", linkSecretCount);
    for (const attachment of attachments) {
      for (const [type, count] of Object.entries(attachment.counts)) {
        if (count) increment(eventCounts, type, count);
      }
    }
    for (const [type, count] of Object.entries(eventCounts)) increment(totals, type, count);
    if (Object.keys(eventCounts).length) perEvent.push({ eventId: event.eventId, counts: eventCounts });

    return {
      ...event,
      text: text.value,
      chatTitle: title.value,
      sourceUrl: sourceUrl.value,
      sourceLocator: sourceLocator.value,
      links: links.map((item) => item.value),
      attachments: attachments.map(({ counts, ...metadata }) => metadata)
    };
  });

  const conversationUpdates = batch.conversationUpdates?.map(update => {
    const title = redactText(update.chatTitle);
    for (const [type, count] of Object.entries(title.counts)) increment(totals, type, count);
    return {...update, chatTitle: title.value};
  });
  return {
    batch: { ...batch, events, ...(conversationUpdates ? {conversationUpdates} : {}) },
    summary: { total: Object.values(totals).reduce((sum, count) => sum + count, 0), byType: totals, events: perEvent }
  };
}
