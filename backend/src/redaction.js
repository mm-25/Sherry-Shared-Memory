const TEXT_PATTERNS = [
  { type: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi },
  { type: "api_key", pattern: /\bsk-(?:ant-)?[a-z0-9_-]{16,}\b/gi },
  { type: "api_key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { type: "api_key", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  {
    type: "credential",
    pattern: /\b(password|passcode|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\b\s*[:=]\s*((?!\[REDACTED_)[^\s,;]{6,})/gi,
    replacement: "$1: [REDACTED_CREDENTIAL]"
  },
  {
    type: "financial_account",
    pattern: /\b(account|routing|iban|swift)\s*(?:number|no\.?|#)?\s*[:=]\s*([A-Z0-9 -]{6,34})/gi,
    replacement: "$1: [REDACTED_FINANCIAL_ACCOUNT]"
  }
];

const CARD_CANDIDATE = /\b(?:\d[ -]*?){13,19}\b/g;
const SENSITIVE_QUERY_KEYS = /^(?:access_token|api[_-]?key|auth|code|credential|key|password|refresh_token|secret|token)$/i;

function luhnValid(value) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function increment(counts, type, amount = 1) {
  counts[type] = (counts[type] || 0) + amount;
}

export function redactText(value) {
  let text = String(value ?? "");
  const counts = {};

  for (const rule of TEXT_PATTERNS) {
    text = text.replace(rule.pattern, (...args) => {
      increment(counts, rule.type);
      if (rule.replacement) {
        return rule.replacement.replace("$1", args[1]);
      }
      return `[REDACTED_${rule.type.toUpperCase()}]`;
    });
  }

  text = text.replace(CARD_CANDIDATE, (candidate) => {
    if (!luhnValid(candidate)) return candidate;
    increment(counts, "payment_card");
    return "[REDACTED_PAYMENT_CARD]";
  });

  return { value: text, counts };
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

  return {
    batch: { ...batch, events },
    summary: { total: Object.values(totals).reduce((sum, count) => sum + count, 0), byType: totals, events: perEvent }
  };
}
