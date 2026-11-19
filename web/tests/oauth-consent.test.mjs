import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const script = await readFile(new URL("../oauth-consent.js", import.meta.url), "utf8");
const helper = await readFile(new URL("../auth-session.js", import.meta.url), "utf8").catch((e) => { if (e.code === "ENOENT") return ""; throw e; });
async function run(fetchImpl, saved = { access_token: "invented-old", refresh_token: "invented-refresh", expires_at: 1 }) {
  let stored = JSON.stringify(saved);
  const nodes = { state: { textContent: "", insertAdjacentElement() {} }, allow: { disabled: true }, csrf: { value: "invented-csrf" } };
  const storage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  const location = { href: "https://sherry.example.test/authorize?client_id=invented" };
  const context = { URL, URLSearchParams, atob, Date, localStorage: storage, location, fetch: fetchImpl,
    document: { getElementById: (id) => nodes[id], createElement: () => ({ hidden: false }) }, addEventListener() {} };
  context.window = context;
  vm.runInNewContext(helper, context);
  await vm.runInNewContext(script, context);
  return { nodes, location, read: () => JSON.parse(stored) };
}

test("approval renews an expired stored sign-in before posting Allow", async () => {
  const calls = [];
  const h = await run(async (url, options) => {
    calls.push({ url, options });
    if (url.includes("grant_type=refresh_token")) return Response.json({ access_token: "invented-new", refresh_token: "invented-next", expires_at: 9999999999 });
    if (options.headers.authorization !== "Bearer invented-new") return new Response("Sign in to Memory before connecting.", { status: 401 });
    return Response.json({ redirectTo: "https://chatgpt.com/connector_platform/oauth_redirect?code=invented" });
  });
  await h.nodes.allow.onclick();
  assert.match(h.location.href, /^https:\/\/chatgpt.com\//);
  assert.equal(h.read().refresh_token, "invented-next");
  assert.equal(calls.length, 2);
});
test("a plaintext consent failure reports its status after reading the body once", async () => {
  const h = await run(async () => new Response("Authorization check failed.", { status: 400 }), { access_token: "invented-valid", expires_at: 9999999999 });
  await h.nodes.allow.onclick();
  assert.match(h.nodes.state.textContent, /400/);
  assert.match(h.nodes.state.textContent, /reload|expired/i);
  assert.equal(h.nodes.allow.disabled, false);
});
test("an uncertain authorization network result is not replayed", async () => {
  let approvals = 0;
  const h = await run(async () => { approvals++; throw new TypeError("network interrupted"); }, { access_token: "invented-valid", expires_at: 9999999999 });
  await h.nodes.allow.onclick();
  assert.equal(approvals, 1);
  assert.match(h.nodes.state.textContent, /confirm|connection|network/i);
});
test("repeated clicks cannot send overlapping approvals", async () => {
  let complete;
  let approvals = 0;
  const pendingResponse = new Promise((resolve) => { complete = resolve; });
  const h = await run(async () => { approvals++; return pendingResponse; }, { access_token: "invented-valid", expires_at: 9999999999 });
  const first = h.nodes.allow.onclick();
  const second = h.nodes.allow.onclick();
  complete(Response.json({ redirectTo: "https://chatgpt.com/connector_platform/oauth_redirect?code=invented" }));
  await Promise.all([first, second]);
  assert.equal(approvals, 1);
});
