// Canonical text-redaction policy shared by cloud ingestion and owner import verification.
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

