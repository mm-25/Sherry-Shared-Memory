export const USER_ID = "0f6f5f4a-4f0d-4e8b-8c2f-135b95268f42";
export const WORKSPACE_ID = "7c895c18-05e4-4f96-9148-37ad93b2a789";
export const BATCH_ID = "5d667d30-8bed-4e63-b16e-9d5e928765c8";

export function validBatch(overrides = {}) {
  return {
    schemaVersion: 1,
    batchId: BATCH_ID,
    workspaceId: WORKSPACE_ID,
    provider: "chatgpt",
    reason: "mutation",
    clientCreatedAt: "2026-09-14T14:00:00.000Z",
    events: [
      {
        eventId: "evt_12ab34cd",
        provider: "chatgpt",
        conversationId: "conversation-123",
        providerMessageId: "message-123",
        sequence: 0,
        role: "user",
        text: "Remember that I prefer concise design reviews.",
        contentHash: "12ab34cd",
        sourceUrl: "https://chatgpt.com/c/conversation-123",
        chatTitle: "Memory Test",
        messageTimestamp: null,
        capturedAt: "2026-09-14T14:00:00.000Z",
        links: ["https://example.com/reference"],
        attachments: []
      }
    ],
    ...overrides
  };
}

export function validBatchV2(overrides = {}) {
  const v1 = validBatch();
  return {
    ...v1,
    schemaVersion: 2,
    providerFamily: "openai",
    product: "chatgpt",
    surface: "web",
    captureClient: {
      type: "browser_dom",
      adapterVersion: "0.2.0",
      deviceId: "device:browser-test",
      os: "macos",
      appVersion: null,
      captureSessionId: "session:browser-test"
    },
    coverage: {
      state: "complete_observed_range",
      gapBefore: false,
      backfillAvailable: true
    },
    events: v1.events.map((event) => ({ ...event, sourceLocator: "web:chatgpt:conversation-123" })),
    ...overrides
  };
}

export function configuredEnv(r2) {
  return {
    RAW_MEMORY: r2,
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    SUPABASE_SECRET_KEY: "sb_secret_test",
    SETTINGS_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    ALLOWED_ORIGINS: "chrome-extension://test-extension",
    ALLOW_FIREFOX_EXTENSION_ORIGINS: "true",
    MAX_BATCH_BYTES: "524288"
  };
}

export class MemoryR2 {
  objects = new Map();
  putCount = 0;
  deleteCount = 0;

  async head(key) {
    const object = this.objects.get(key);
    return object ? { customMetadata: object.options.customMetadata } : null;
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      customMetadata: object.options.customMetadata,
      json: async () => JSON.parse(object.value)
    };
  }

  async put(key, value, options) {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    this.objects.set(key, { value, options });
    this.putCount += 1;
    return { customMetadata: options?.customMetadata };
  }

  async delete(key) {
    this.objects.delete(key);
    this.deleteCount += 1;
  }
}
