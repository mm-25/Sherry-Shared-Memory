import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultHandler } from "../src/oauth.js";

test("consent permits renewal only against its configured Supabase origin", async () => {
  const handler = createDefaultHandler({ fetch() { assert.fail("The authorize page must use its own handler"); } });
  const response = await handler.fetch(new Request("https://sherry.example.test/authorize?client_id=invented"), {
    SUPABASE_URL: "https://project.supabase.co",
    OAUTH_PROVIDER: { parseAuthRequest: async () => ({ clientId: "invented", scope: ["memory:read"] }),
      lookupClient: async () => ({ clientName: "Codex" }) }
  }, {});
  assert.equal(response.status, 200);
  const policy = response.headers.get("content-security-policy");
  assert.match(policy, /connect-src 'self' https:\/\/project\.supabase\.co;/);
  assert.match(policy, /script-src 'self';/);
  assert.match(policy, /frame-ancestors 'none';/);
  assert.doesNotMatch(policy, /https:\/\/\*|connect-src \*/);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; Secure;/);
});
